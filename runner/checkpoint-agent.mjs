#!/usr/bin/env node
/**
 * OMP runner checkpoint agent.
 *
 * Runs on the Docker host next to the runner container and exposes a tiny
 * authenticated API for CRIU checkpoints and portable handoff bundles through
 * the Docker Engine API.
 *
 *   CHECKPOINT_TOKEN=... node checkpoint-agent.mjs
 *
 * SECURITY: mounting the Docker socket and Docker data root grants root-
 * equivalent control of the host. Bind this agent to loopback, keep the token
 * secret, and never expose it on a public interface.
 */
import { createServer, request as httpRequest } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const PORT = Number(process.env.CHECKPOINT_PORT || 43160);
const HOST = process.env.CHECKPOINT_HOST || "127.0.0.1";
const TOKEN = process.env.CHECKPOINT_TOKEN || "";
const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const DOCKER_ROOT = process.env.DOCKER_ROOT || "/var/lib/docker";
const BACKUP_DIR = process.env.BACKUP_DIR || "/backups";

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

function dockerBinary(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: SOCKET, path, method, headers: body ? { "content-type": "application/x-tar" } : {} }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode >= 400) {
          reject(new Error(`Docker HTTP ${response.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    request.on("error", reject);
    if (body) request.write(body);
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
      if (body.length > 2_000_000) request.destroy();
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

function inspectContainer(container) {
  return docker("GET", `/containers/${encodeURIComponent(container)}/json`);
}

function containerId(info) {
  return String(info?.Id || "");
}

function checkpointPath(id, name) {
  return join(DOCKER_ROOT, "containers", id, "checkpoints", name);
}

function tarCreate(source, target) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const result = spawnSync("tar", ["-czf", target, "-C", source, "."], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "tar failed");
}

function tarExtract(bundle, target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const result = spawnSync("tar", ["-xzf", bundle, "-C", target], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "tar failed");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    json(response, 200, { ok: true, service: "omp-checkpoint", host: HOST, dockerRoot: DOCKER_ROOT, backupDir: BACKUP_DIR });
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
    if (url.pathname === "/bundles" && request.method === "GET") {
      const entries = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).filter((name) => name.endsWith(".tar.gz")) : [];
      json(response, 200, entries.map((name) => ({ name, path: join(BACKUP_DIR, name) })));
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

    if (url.pathname === "/export" && request.method === "POST") {
      const body = await readBody(request);
      const container = String(body.container || "omp-runner");
      const checkpoint = String(body.name || `omp-${Date.now()}`);
      const info = await inspectContainer(container);
      const id = containerId(info);
      if (!id) throw new Error("Container not found");
      const existing = await docker("GET", `/containers/${encodeURIComponent(container)}/checkpoints`);
      if (!Array.isArray(existing) || !existing.some((item) => item.Name === checkpoint)) {
        await docker("POST", `/containers/${encodeURIComponent(container)}/checkpoints`, { CheckpointID: checkpoint, Exit: true });
      }
      const temp = join(BACKUP_DIR, `export-${checkpoint}`);
      rmSync(temp, { recursive: true, force: true });
      mkdirSync(temp, { recursive: true });
      cpSync(checkpointPath(id, checkpoint), join(temp, "checkpoint"), { recursive: true });
      try {
        const archive = await dockerBinary("GET", `/containers/${encodeURIComponent(id)}/archive?path=%2Fdata`);
        writeFileSync(join(temp, "data.tar"), archive);
      } catch {
        // no /data directory in this container
      }
      const metadata = {
        createdAt: new Date().toISOString(),
        checkpoint,
        config: info.Config,
        hostConfig: info.HostConfig,
        mounts: info.Mounts, // named volume/bind metadata for manual data transfer
        containerName: String(info.Name || container).replace(/^\//, ""),
      };
      writeFileSync(join(temp, "container.json"), JSON.stringify(metadata, null, 2));
      const bundle = join(BACKUP_DIR, `${checkpoint}.tar.gz`);
      tarCreate(temp, bundle);
      rmSync(temp, { recursive: true, force: true });
      json(response, 200, { ok: true, container, checkpoint, bundle, bytes: readFileSync(bundle).length });
      return;
    }

    if (url.pathname === "/import" && request.method === "POST") {
      const body = await readBody(request);
      const bundle = String(body.bundle || "");
      const name = String(body.name || "").trim();
      if (!bundle || !existsSync(bundle)) {
        json(response, 400, { error: "Bundle not found" });
        return;
      }
      const temp = join(BACKUP_DIR, `import-${Date.now()}`);
      tarExtract(bundle, temp);
      const metadata = JSON.parse(readFileSync(join(temp, "container.json"), "utf8"));
      const config = metadata.config || {};
      const hostConfig = metadata.hostConfig || {};
      const binds = Array.isArray(hostConfig.Binds) && hostConfig.Binds.length
        ? hostConfig.Binds
        : (metadata.mounts || []).filter((mount) => mount.Source && mount.Destination).map((mount) => `${mount.Name || mount.Source}:${mount.Destination}`);
      const createBody = {
        Image: config.Image,
        Cmd: config.Cmd,
        Entrypoint: config.Entrypoint,
        Env: config.Env,
        Labels: config.Labels,
        WorkingDir: config.WorkingDir,
        User: config.User,
        Tty: config.Tty,
        OpenStdin: config.OpenStdin,
        HostConfig: {
          NetworkMode: hostConfig.NetworkMode || "host",
          Binds: binds,
          Mounts: hostConfig.Mounts,
          Privileged: hostConfig.Privileged,
          CapAdd: hostConfig.CapAdd,
          SecurityOpt: hostConfig.SecurityOpt,
          RestartPolicy: hostConfig.RestartPolicy,
          AutoRemove: false,
        },
      };
      const containerName = name || `${metadata.containerName || "omp-runner"}-imported`;
      const created = await docker("POST", `/containers/create?name=${encodeURIComponent(containerName)}`, createBody);
      const id = created?.Id;
      if (!id) throw new Error("Docker did not create a container");
      const destination = checkpointPath(id, metadata.checkpoint);
      mkdirSync(join(DOCKER_ROOT, "containers", id, "checkpoints"), { recursive: true });
      cpSync(join(temp, "checkpoint"), destination, { recursive: true });
      if (existsSync(join(temp, "data.tar"))) {
        await dockerBinary("PUT", `/containers/${encodeURIComponent(id)}/archive?path=%2F`, readFileSync(join(temp, "data.tar")));
      }
      rmSync(temp, { recursive: true, force: true });
      await docker("POST", `/containers/${encodeURIComponent(id)}/start?checkpoint=${encodeURIComponent(metadata.checkpoint)}`);
      json(response, 200, { ok: true, container: containerName, id, checkpoint: metadata.checkpoint });
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OMP checkpoint agent on http://${HOST}:${PORT} (socket ${SOCKET}, root ${DOCKER_ROOT})`);
});


