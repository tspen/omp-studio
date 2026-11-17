import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, relative, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import JSZip from "jszip";
import { WebSocketServer, type WebSocket } from "ws";
import { app } from "electron";
import type { AppEvent, ChatMessage, RemoteInfo, RemoteTarget, RemoteTargetInput, Thread, TreeNode } from "../../shared/types";
import type { Orchestrator } from "../orchestrator/orchestrator";
import { collectGarbage } from "./maintenance";
import { newId, type Store } from "./store";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export class RemoteService {
  private store: Store;
  private orchestrator: Orchestrator;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private port = 0;
  private host = "";
  private lastError: string | undefined;

  constructor(store: Store, orchestrator: Orchestrator) {
    this.store = store;
    this.orchestrator = orchestrator;
  }

  token(): string {
    const fromEnv = process.env.OMP_REMOTE_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    let token = this.store.getSecret("remote.token");
    if (!token) {
      token = randomBytes(24).toString("hex");
      this.store.setSecret("remote.token", token);
    }
    return token;
  }

  rotateToken(): void {
    this.store.setSecret("remote.token", randomBytes(24).toString("hex"));
    for (const client of this.clients) client.close(4001, "token rotated");
    this.clients.clear();
  }

  running(): boolean {
    return !!this.server;
  }

  listTargets(): RemoteTarget[] {
    return this.store.settings.remoteTargets ?? [];
  }

  private saveTargets(targets: RemoteTarget[]): RemoteTarget[] {
    this.store.setSettings({ remoteTargets: targets });
    return targets;
  }

  private targetToken(id: string): string {
    return this.store.getSecret(`target.${id}`) ?? "";
  }

  private async probe(url: string, token: string): Promise<number> {
    const started = Date.now();
    const response = await fetch(`${url.replace(/\/+$/, "")}/api/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(response.status === 401 ? "Token was rejected by the target" : `Target returned HTTP ${response.status}`);
    return Date.now() - started;
  }

  async addTarget(input: RemoteTargetInput): Promise<RemoteTarget[]> {
    const url = normalizeUrl(input.url);
    const name = input.name.trim() || new URL(url).host;
    const token = input.token.trim();
    if (!token) throw new Error("A pairing token is required");
    const latencyMs = await this.probe(url, token);
    const id = newId("tgt");
    this.store.setSecret(`target.${id}`, token);
    const target: RemoteTarget = {
      id,
      name,
      url,
      kind: input.kind ?? "paired",
      status: "online",
      latencyMs,
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };
    return this.saveTargets([...this.listTargets().filter((item) => item.url !== url), target]);
  }

  removeTarget(id: string): RemoteTarget[] {
    this.store.deleteSecret(`target.${id}`);
    return this.saveTargets(this.listTargets().filter((item) => item.id !== id));
  }

  async testTarget(id: string): Promise<RemoteTarget[]> {
    const targets = this.listTargets();
    const target = targets.find((item) => item.id === id);
    if (!target) throw new Error("Target not found");
    let next: RemoteTarget;
    try {
      const latencyMs = await this.probe(target.url, this.targetToken(id));
      next = { ...target, status: "online", latencyMs, lastSeen: Date.now(), error: undefined };
    } catch (error) {
      next = { ...target, status: "offline", latencyMs: undefined, error: error instanceof Error ? error.message : String(error) };
    }
    return this.saveTargets(targets.map((item) => (item.id === id ? next : item)));
  }

  /** Cold move: export this thread and import it into a registered target. */
  async moveThread(threadId: string, targetId: string): Promise<{ threadId: string; nodeId: string }> {
    const target = this.listTargets().find((item) => item.id === targetId);
    if (!target) throw new Error("Target not found");
    const token = this.targetToken(targetId);
    if (!token) throw new Error("Target token is missing; remove and re-add the target");
    const bundle = await this.exportBundle(threadId);
    const response = await fetch(`${target.url}/api/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ bundle: bundle.bundle }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => ({}))) as { threadId?: string; nodeId?: string; error?: string };
    if (!response.ok || !body.threadId || !body.nodeId) throw new Error(body.error || `Target import failed with HTTP ${response.status}`);
    this.saveTargets(this.listTargets().map((item) => (item.id === targetId ? { ...item, lastSeen: Date.now(), status: "online", error: undefined } : item)));
    return { threadId: body.threadId, nodeId: body.nodeId };
  }

  async info(): Promise<RemoteInfo> {
    const settings = this.store.settings.remote;
    const token = this.token();
    const urls = this.urls();
    const qr = urls[0] ? await QRCode.toDataURL(`${urls[0]}/#t=${encodeURIComponent(token)}`, { margin: 1, width: 280 }).catch(() => undefined) : undefined;
    return {
      enabled: settings.enabled !== false,
      running: this.running(),
      host: this.host || settings.host,
      port: this.port || settings.port,
      token,
      urls,
      qr,
      keepRunning: !!settings.keepRunning,
      error: this.lastError,
    };
  }

  async start(): Promise<RemoteInfo> {
    if (this.server) return this.info();
    const settings = this.store.settings.remote;
    const preferred = Math.max(1024, Number(process.env.OMP_REMOTE_PORT) || Number(settings.port) || 43120);
    const host = process.env.OMP_REMOTE_HOST || settings.host || "127.0.0.1";
    let port = preferred;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        this.server = createServer((request, response) => void this.handle(request, response));
        this.wss = new WebSocketServer({ noServer: true });
        this.wss.on("connection", (socket) => this.connect(socket));
        this.server.on("upgrade", (request, socket, head) => {
          const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
          if (!this.authorized(request, url)) {
            socket.destroy();
            return;
          }
          this.wss!.handleUpgrade(request, socket, head, (ws) => this.wss!.emit("connection", ws, request));
        });
        await new Promise<void>((resolvePromise, reject) => {
          const onError = (error: NodeJS.ErrnoException) => {
            this.server?.off("listening", onListening);
            this.server?.close();
            this.server = null;
            this.wss?.close();
            this.wss = null;
            reject(error);
          };
          const onListening = () => {
            this.server?.off("error", onError);
            resolvePromise();
          };
          this.server!.once("error", onError);
          this.server!.once("listening", onListening);
          this.server!.listen(port, host);
        });
        this.port = port;
        this.host = host;
        this.lastError = undefined;
        this.store.setSettings({ remote: { ...settings, enabled: true, port, host } });
        const urls = this.urls();
        const token = this.token();
        console.log(`OMP Remote listening on ${host}:${port}`);
        for (const url of urls) console.log(`OMP Remote pairing link: ${url}/#t=${encodeURIComponent(token)}`);
        return this.info();
      } catch (error) {
        this.server?.close();
        this.server = null;
        this.wss?.close();
        this.wss = null;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE" && attempt < 19) {
          port += 1;
          continue;
        }
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    throw new Error("Could not find a free port for the remote server");
  }

  async stop(): Promise<RemoteInfo> {
    for (const client of this.clients) client.close();
    this.clients.clear();
    await new Promise<void>((resolvePromise) => {
      if (!this.server) return resolvePromise();
      this.server.close(() => resolvePromise());
    });
    this.server = null;
    this.wss?.close();
    this.wss = null;
    this.port = 0;
    this.store.setSettings({ remote: { ...this.store.settings.remote, enabled: false } });
    return this.info();
  }

  publish(event: AppEvent): void {
    if (!this.clients.size) return;
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  private connect(socket: WebSocket): void {
    this.clients.add(socket);
    socket.send(JSON.stringify({ type: "snapshot", payload: this.orchestrator.snapshot() } satisfies AppEvent));
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data)) as { type?: string; threadId?: string; lastSeq?: number };
        if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
      } catch {
        /* ignore malformed client messages */
      }
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "authorization,content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (!url.pathname.startsWith("/api/")) {
      this.serveStatic(url.pathname, response);
      return;
    }
    if (!this.authorized(request, url)) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      await this.api(request, response, url);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[1] === "health") return json(200, { ok: true, name: "OMP Studio", version: app.getVersion() });
    if (parts[1] === "state") return json(200, this.orchestrator.snapshot());
    if (parts[1] === "approvals" && !parts[2] && request.method === "GET") return json(200, this.orchestrator.pendingApprovals());
    if (parts[1] === "messages" && parts[2]) return json(200, this.store.getChat(decodeURIComponent(parts[2])));
    if (parts[1] === "threads" && parts[2]) {
      const threadId = decodeURIComponent(parts[2]);
      const action = parts[3];
      if (request.method === "GET" && !action) {
        const thread = this.store.getThread(threadId);
        return thread ? json(200, { thread, messages: this.store.getChat(threadId) }) : json(404, { error: "Thread not found" });
      }
      if (request.method === "POST" && action) {
        const body = await readJson(request);
        if (action === "send") {
          await this.orchestrator.sendUserMessage({ threadId, text: String(body.text ?? ""), mode: "prompt", checkpoint: true });
          return json(200, { ok: true });
        }
        if (action === "stop") {
          await this.orchestrator.stopThread(threadId);
          return json(200, { ok: true });
        }
        if (action === "continue") {
          await this.orchestrator.continueThread(threadId);
          return json(200, { ok: true });
        }
        if (action === "compact") {
          await this.orchestrator.compactThread(threadId);
          return json(200, { ok: true });
        }
      }
    }
    if (parts[1] === "approvals" && parts[2] && request.method === "POST") {
      const body = await readJson(request);
      await this.orchestrator.respondApproval(decodeURIComponent(parts[2]), body.response);
      return json(200, { ok: true });
    }
    if (parts[1] === "envelopes" && parts[2] && parts[3] === "answer" && request.method === "POST") {
      const body = await readJson(request);
      await this.orchestrator.answerEnvelope(decodeURIComponent(parts[2]), String(body.body ?? ""));
      return json(200, { ok: true });
    }
    if (parts[1] === "export" && parts[2] && request.method === "GET") {
      const bundle = await this.exportBundle(decodeURIComponent(parts[2]));
      return json(200, bundle);
    }
    if (parts[1] === "import" && request.method === "POST") {
      const body = await readJson(request);
      return json(200, await this.importBundle(String(body.bundle ?? "")));
    }
    if (parts[1] === "maintenance" && parts[2] === "sweep" && request.method === "POST") {
      const body = await readJson(request);
      const report = await collectGarbage(this.store.baseDir, { nodes: this.store.nodes, threads: this.store.threads }, { dryRun: body.dryRun !== false });
      return json(200, report);
    }
    if (parts[1] === "nodes" && parts[2] && request.method === "DELETE") {
      if (parts[2] === "root") return json(400, { error: "Cannot delete the root node" });
      await this.orchestrator.deleteNode(decodeURIComponent(parts[2]));
      return json(200, { ok: true });
    }
    json(404, { error: "Not found" });
  }

  private async exportBundle(threadId: string): Promise<{ name: string; bundle: string }> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const node = this.store.getNode(thread.nodeId);
    if (!node) throw new Error("Node not found");
    const zip = new JSZip();
    const cwd = thread.worktreePath || node.repoPath || node.path;
    const chat = this.store.getChat(threadId);
    const manifest = {
      format: "omp-session-v1",
      createdAt: Date.now(),
      node: { name: node.name, type: node.type, path: node.path, repoPath: node.repoPath, description: node.description, approvalMode: node.approvalMode, gitMode: node.gitMode },
      thread: { title: thread.title, kind: thread.kind, model: thread.model, effort: thread.effort, sessionFile: thread.sessionFile, todoPhases: thread.todoPhases, lastMessage: thread.lastMessage },
      chat,
    };
    zip.file("manifest.json", JSON.stringify(manifest));
    let total = 0;
    const addTree = (root: string, prefix: string) => {
      const walk = (directory: string) => {
        let entries;
        try {
          entries = readdirSync(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (total > 200 * 1024 * 1024) return;
          if (entry.name === "node_modules" || entry.name === ".venv" || entry.name === "__pycache__") continue;
          const full = join(directory, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            try {
              const size = statSync(full).size;
              if (size > 20 * 1024 * 1024) continue;
              total += size;
              zip.file(`${prefix}/${relative(root, full).replace(/\\/g, "/")}`, readFileSync(full));
            } catch {
              /* skip unreadable */
            }
          }
        }
      };
      walk(root);
    };
    if (existsSync(cwd)) addTree(cwd, "workspace");
    if (existsSync(thread.sessionDir)) addTree(thread.sessionDir, "session");
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    return { name: `${thread.title} (${node.name})`, bundle: buffer.toString("base64") };
  }

  private async importBundle(base64: string): Promise<{ threadId: string; nodeId: string }> {
    if (!base64) throw new Error("Bundle is required");
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length || buffer.length > 200 * 1024 * 1024) throw new Error("Invalid or oversized bundle");
    const zip = await JSZip.loadAsync(buffer);
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile) throw new Error("Bundle has no manifest.json");
    const manifest = JSON.parse(await manifestFile.async("string")) as any;
    if (manifest.format !== "omp-session-v1") throw new Error("Unsupported bundle format");
    const quota = await collectGarbage(this.store.baseDir, { nodes: this.store.nodes, threads: this.store.threads }, { dryRun: true });
    if (quota.quotaUsedPct >= 100) throw new Error("Runner disk quota is full; clean up before importing");
    const root = this.store.nodes.find((node) => node.type === "root");
    if (!root) throw new Error("Root node not found");
    const nodeId = newId("prj");
    const targetDir = join(this.store.baseDir, "workspaces", `imported-${nodeId}`);
    mkdirSync(targetDir, { recursive: true });
    const now = Date.now();
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (name.startsWith("workspace/")) {
        const rel = name.slice("workspace/".length);
        if (!rel || rel.split("/").includes("..")) continue;
        const full = join(targetDir, rel);
        mkdirSync(resolve(full, ".."), { recursive: true });
        writeFileSync(full, await entry.async("nodebuffer"));
      }
    }
    const node: TreeNode = {
      id: nodeId,
      type: "project",
      name: `${String(manifest.node?.name ?? "Imported project")} (moved)`,
      parentId: root.id,
      path: targetDir,
      repoPath: existsSync(join(targetDir, ".git")) ? targetDir : undefined,
      description: manifest.node?.description,
      orchestratorThreadId: newId("thr"),
      model: this.store.settings.models.project || "",
      effort: this.store.settings.models.projectEffort || "high",
      gitMode: "shared",
      approvalMode: manifest.node?.approvalMode ?? this.store.settings.defaultApprovalMode ?? "yolo",
      collapsed: false,
      muted: false,
      autoName: false,
      createdAt: now,
      updatedAt: now,
    };
    this.store.addNode(node);
    const orchestrator: Thread = {
      id: node.orchestratorThreadId,
      nodeId,
      parentThreadId: null,
      kind: "orchestrator",
      title: node.name,
      titleAuto: false,
      status: "idle",
      model: { provider: "", id: "", selector: node.model, name: node.model },
      effort: node.effort,
      sessionDir: join(this.store.sessionsDir, node.orchestratorThreadId),
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      unread: 0,
      pinned: false,
      archived: false,
      muted: false,
      cost: 0,
      tokens: 0,
      todoPhases: [],
      source: "app",
    };
    this.store.addThread(orchestrator);
    const threadId = newId("thr");
    const sessionDir = join(this.store.sessionsDir, threadId);
    mkdirSync(sessionDir, { recursive: true });
    let sessionFile: string | undefined;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (!name.startsWith("session/")) continue;
      const rel = name.slice("session/".length);
      if (!rel || rel.split("/").includes("..")) continue;
      const full = join(sessionDir, rel);
      mkdirSync(resolve(full, ".."), { recursive: true });
      writeFileSync(full, await entry.async("nodebuffer"));
      if (!sessionFile && rel.toLowerCase().endsWith(".jsonl")) sessionFile = full;
    }
    const imported: Thread = {
      id: threadId,
      nodeId,
      parentThreadId: node.orchestratorThreadId,
      kind: manifest.thread?.kind === "worker" ? "worker" : "orchestrator",
      title: String(manifest.thread?.title ?? "Imported session"),
      titleAuto: false,
      status: "idle",
      model: manifest.thread?.model ?? { provider: "", id: "", selector: node.model, name: node.model },
      effort: manifest.thread?.effort ?? node.effort,
      sessionDir,
      sessionFile,
      lastMessage: manifest.thread?.lastMessage,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      unread: 0,
      pinned: false,
      archived: false,
      muted: false,
      cost: 0,
      tokens: 0,
      todoPhases: manifest.thread?.todoPhases ?? [],
      source: "app",
    };
    this.store.addThread(imported);
    this.store.replaceChat(threadId, Array.isArray(manifest.chat) ? (manifest.chat as ChatMessage[]) : []);
    this.orchestrator.notify({ type: "node:updated", payload: node });
    this.orchestrator.notify({ type: "thread:updated", payload: orchestrator });
    this.orchestrator.notify({ type: "thread:updated", payload: imported });
    return { threadId, nodeId };
  }

  private serveStatic(pathname: string, response: ServerResponse): void {
    const root = this.mobileRoot();
    const requested = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    let file = normalize(join(root, requested));
    if (!file.startsWith(normalize(root))) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!existsSync(file) || !extname(file)) file = join(root, "index.html");
    if (!existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain" }).end("Mobile UI not built. Run npm run build:mobile.");
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    });
    response.end(readFileSync(file));
  }

  private mobileRoot(): string {
    const packaged = join(app.getAppPath(), "out", "mobile");
    if (existsSync(packaged)) return packaged;
    return resolve(process.cwd(), "out", "mobile");
  }

  private urls(): string[] {
    const port = this.port || this.store.settings.remote.port || 43120;
    const host = this.host || this.store.settings.remote.host || "127.0.0.1";
    const result = new Set<string>();
    if (host === "0.0.0.0" || host === "::") {
      result.add(`http://127.0.0.1:${port}`);
      for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
          if (entry.family === "IPv4" && !entry.internal) result.add(`http://${entry.address}:${port}`);
        }
      }
    } else {
      result.add(`http://${host === "::1" ? "127.0.0.1" : host}:${port}`);
    }
    return [...result];
  }

  private authorized(request: IncomingMessage, url?: URL): boolean {
    const header = String(request.headers.authorization ?? "");
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const query = url?.searchParams.get("token") ?? "";
    const provided = bearer || query;
    if (!provided) return false;
    const expected = this.token();
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 300_000_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("A runner URL is required");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return new URL(withScheme).toString().replace(/\/+$/, "");
}




