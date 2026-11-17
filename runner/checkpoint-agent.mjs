#!/usr/bin/env node
/**
 * OMP runner checkpoint agent.
 *
 * Runs on the Docker host next to the runner container and exposes a tiny
 * authenticated API for CRIU checkpoints through the Docker Engine API.
 *
 *   CHECKPOINT_TOKEN=... node checkpoint-agent.mjs
 *
 * SECURITY: mounting the Docker socket grants root-equivalent control of the
 * host. Bind this agent to loopback, keep the token secret, and never expose it
 * on a public interface.
 */
import { createServer, request as httpRequest } from "node:http";

const PORT = Number(process.env.CHECKPOINT_PORT || 43160);
const HOST = process.env.CHECKPOINT_HOST || "127.0.0.1";
const TOKEN = process.env.CHECKPOINT_TOKEN || "";
const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

if (!TOKEN) {
  console.error("CHECKPOINT_TOKEN is required");
  process.exit(2);
}

function docker(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: SOCKET, path, method, headers: { "content-type": "application/json" } }, (response) => {
      let data = "";
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = data;
        }
        if (response.statusCode >= 400) {
          reject(new Error(typeof parsed === "object" && parsed?.message ? parsed.message : `Docker HTTP ${response.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on("error", reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function authorized(request) {
  const header = String(request.headers.authorization || "");
  return header === `Bearer ${TOKEN}`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    json(response, 200, { ok: true, service: "omp-checkpoint", host: HOST });
    return;
  }
  if (!authorized(request)) {
    json(response, 401, { error: "Unauthorized" });
    return;
  }
  try {
    if (url.pathname === "/checkpoints" && request.method === "GET") {
      const container = url.searchParams.get("container") || "omp-runner";
      const list = await docker("GET", `/containers/${encodeURIComponent(container)}/checkpoints`);
      json(response, 200, list);
      return;
    }
    if (url.pathname === "/checkpoint" && request.method === "POST") {
      const body = await readBody(request);
      const container = String(body.container || "omp-runner");
      const name = String(body.name || `omp-${Date.now()}`);
      await docker("POST", `/containers/${encodeURIComponent(container)}/checkpoints`, { CheckpointID: name, Exit: true });
      json(response, 200, { ok: true, container, name });
      return;
    }
    if (url.pathname === "/restore" && request.method === "POST") {
      const body = await readBody(request);
      const container = String(body.container || "omp-runner");
      const name = String(body.name || "");
      if (!name) {
        json(response, 400, { error: "Checkpoint name is required" });
        return;
      }
      await docker("POST", `/containers/${encodeURIComponent(container)}/start?checkpoint=${encodeURIComponent(name)}`);
      json(response, 200, { ok: true, container, name });
      return;
    }
    if (url.pathname === "/checkpoint" && request.method === "DELETE") {
      const body = await readBody(request);
      const container = String(body.container || "omp-runner");
      const name = String(body.name || "");
      if (!name) {
        json(response, 400, { error: "Checkpoint name is required" });
        return;
      }
      await docker("DELETE", `/containers/${encodeURIComponent(container)}/checkpoints/${encodeURIComponent(name)}`);
      json(response, 200, { ok: true, container, name });
      return;
    }
    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OMP checkpoint agent on http://${HOST}:${PORT} (socket ${SOCKET})`);
});


