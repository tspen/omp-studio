#!/usr/bin/env node
/**
 * OMP self-hosted relay.
 *
 * A runner dials out to this process; phones connect to it. The relay forwards
 * opaque encrypted frames and keeps no state on disk. It never sees prompts,
 * session data or API responses.
 *
 *   RELAY_PORT=43150 RELAY_HOST=127.0.0.1 node relay/server.mjs
 *
 * Put it behind Tailscale, a private reverse proxy, or a TLS terminator you
 * control. Do not expose it directly to the public internet without TLS.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.RELAY_PORT || 43150);
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const MOBILE_DIR = process.env.RELAY_MOBILE_DIR || resolve(fileURLToPath(new URL("..", import.meta.url)), "out", "mobile");
const MAX_FRAME = Number(process.env.RELAY_MAX_FRAME || 32 * 1024 * 1024);
const ROOM_GRACE_MS = Number(process.env.RELAY_ROOM_GRACE_MS || 5 * 60_000);
const MAX_CLIENTS = Number(process.env.RELAY_MAX_CLIENTS || 8);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** @type {Map<string, { tokenHash: string, runner: import("ws").WebSocket | null, clients: Map<string, import("ws").WebSocket>, reap?: NodeJS.Timeout }>} */
const rooms = new Map();
let clientSeq = 0;

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function tokenFrom(request, url) {
  const header = String(request.headers.authorization ?? "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return url.searchParams.get("token") ?? "";
}

function reject(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/health") {
    const clients = [...rooms.values()].reduce((sum, room) => sum + room.clients.size, 0);
    const runners = [...rooms.values()].filter((room) => room.runner).length;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, rooms: rooms.size, runners, clients }));
    return;
  }
  if (url.pathname === "/relay-info") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "OMP Relay", rooms: rooms.size, maxClients: MAX_CLIENTS }));
    return;
  }
  serveStatic(url.pathname, response);
});

function serveStatic(pathname, response) {
  const requested = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  let file = normalize(join(MOBILE_DIR, requested));
  if (!file.startsWith(normalize(MOBILE_DIR))) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(file) || !extname(file)) file = join(MOBILE_DIR, "index.html");
  if (!existsSync(file)) {
    response.writeHead(404, { "content-type": "text/plain" }).end("OMP relay is running. Build the PWA with npm run build:mobile.");
    return;
  }
  response.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  response.end(readFileSync(file));
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname !== "/ws") return reject(socket, 404, "Not Found");
  const role = url.searchParams.get("role");
  const roomId = (url.searchParams.get("room") ?? "").trim();
  const token = tokenFrom(request, url);
  if (!roomId || !token || !["runner", "client"].includes(role)) return reject(socket, 400, "Bad Request");
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(roomId)) return reject(socket, 400, "Bad Room");

  const hash = tokenHash(token);
  let room = rooms.get(roomId);
  if (role === "runner") {
    if (room && !safeEqual(room.tokenHash, hash)) return reject(socket, 403, "Forbidden");
    if (!room) {
      room = { tokenHash: hash, runner: null, clients: new Map() };
      rooms.set(roomId, room);
    }
    if (room.reap) {
      clearTimeout(room.reap);
      room.reap = undefined;
    }
  } else {
    if (!room) return reject(socket, 404, "No Runner");
    if (!safeEqual(room.tokenHash, hash)) return reject(socket, 403, "Forbidden");
    if (room.clients.size >= MAX_CLIENTS) return reject(socket, 429, "Too Many Clients");
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    const clientId = `c${++clientSeq}-${role}`;
    if (role === "runner") {
      if (room.runner && room.runner.readyState === 1) room.runner.close(4001, "replaced");
      room.runner = ws;
      console.log(`relay: runner online room=${roomId}`);
      ws.send(JSON.stringify({ t: "relay", state: "ready", clients: room.clients.size }));
      for (const client of room.clients.values()) if (client.readyState === 1) client.send(JSON.stringify({ t: "relay", state: "online" }));
      ws.on("message", (data) => {
        let envelope;
        try {
          envelope = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!envelope || typeof envelope.data !== "string") return;
        if (process.env.RELAY_DEBUG_FRAMES === "1") console.log(`relay: frame room=${roomId} from=runner bytes=${envelope.data.length} sample=${envelope.data.slice(0, 72)}`);
        if (envelope.to === "*") {
          for (const client of room.clients.values()) if (client.readyState === 1) client.send(JSON.stringify({ t: "frame", data: envelope.data }));
        } else if (envelope.to && room.clients.has(envelope.to)) {
          const client = room.clients.get(envelope.to);
          if (client.readyState === 1) client.send(JSON.stringify({ t: "frame", data: envelope.data }));
        }
      });
      ws.on("close", () => {
        if (room.runner === ws) {
          room.runner = null;
          console.log(`relay: runner offline room=${roomId}`);
          for (const client of room.clients.values()) if (client.readyState === 1) client.send(JSON.stringify({ t: "relay", state: "offline" }));
          room.reap = setTimeout(() => {
            if (!room.runner && room.clients.size === 0) {
              rooms.delete(roomId);
              console.log(`relay: room reaped room=${roomId}`);
            }
          }, ROOM_GRACE_MS);
          room.reap.unref?.();
        }
      });
      return;
    }

    // client
    room.clients.set(clientId, ws);
    console.log(`relay: client online room=${roomId} id=${clientId}`);
    ws.send(JSON.stringify({ t: "relay", state: room.runner ? "online" : "offline", id: clientId }));
    if (room.runner?.readyState === 1) room.runner.send(JSON.stringify({ t: "client-open", id: clientId }));
    ws.on("message", (data) => {
      let envelope;
      try {
        envelope = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!envelope || typeof envelope.data !== "string") return;
      if (process.env.RELAY_DEBUG_FRAMES === "1") console.log(`relay: frame room=${roomId} from=${clientId} bytes=${envelope.data.length} sample=${envelope.data.slice(0, 72)}`);
      if (room.runner?.readyState === 1) room.runner.send(JSON.stringify({ from: clientId, data: envelope.data }));
    });
    ws.on("close", () => {
      room.clients.delete(clientId);
      console.log(`relay: client offline room=${roomId} id=${clientId}`);
      if (room.runner?.readyState === 1) room.runner.send(JSON.stringify({ t: "client-close", id: clientId }));
      if (!room.runner && room.clients.size === 0 && !room.reap) {
        room.reap = setTimeout(() => {
          if (!room.runner && room.clients.size === 0) rooms.delete(roomId);
        }, ROOM_GRACE_MS);
        room.reap.unref?.();
      }
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`OMP relay listening on http://${HOST}:${PORT}`);
  console.log(`Static PWA: ${MOBILE_DIR}`);
});

function shutdown() {
  console.log("relay: shutting down");
  for (const room of rooms.values()) {
    room.runner?.close(1001, "relay shutdown");
    for (const client of room.clients.values()) client.close(1001, "relay shutdown");
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

