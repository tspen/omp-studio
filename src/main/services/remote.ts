import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, relative, resolve } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import JSZip from "jszip";
import { WebSocketServer, type WebSocket } from "ws";
import webpush from "web-push";
import { app } from "electron";
import type { AppEvent, ChatMessage, MoveResult, PlacementPolicy, PlacementResult, RemoteInfo, RemoteUsage, TargetUsage, RemoteTarget, RemoteTargetInput, Thread, TreeNode } from "../../shared/types";
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
  private placementReport: PlacementResult | null = null;
  private fileHashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();
  private pushSubscriptions: Array<{ endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }> | null = null;

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
      sandboxId: input.sandboxId,
      template: input.template,
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

  /** Cold or warm move: export this thread and import it into a registered target. */
  async moveThread(threadId: string, targetId: string): Promise<MoveResult> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    if (["running", "starting", "waiting", "queued"].includes(thread.status)) throw new Error("Wait for the current turn to finish before moving this session");
    const target = this.listTargets().find((item) => item.id === targetId);
    if (!target) throw new Error("Target not found");
    const token = this.targetToken(targetId);
    if (!token) throw new Error("Target token is missing; remove and re-add the target");
    const bundle = await this.exportBundle(threadId, { target, token });
    const response = await fetch(`${target.url}/api/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ bundle: bundle.bundle }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => ({}))) as Partial<MoveResult> & { error?: string };
    if (!response.ok || !body.threadId || !body.nodeId) throw new Error(body.error || `Target import failed with HTTP ${response.status}`);
    await this.orchestrator.releaseThreadSession(threadId);
    this.saveTargets(this.listTargets().map((item) => (item.id === targetId ? { ...item, lastSeen: Date.now(), status: "online", error: undefined } : item)));
    return {
      threadId: body.threadId!,
      nodeId: body.nodeId!,
      warm: !!body.warm,
      filesWritten: Number(body.filesWritten ?? bundle.filesWritten),
      filesDeleted: Number(body.filesDeleted ?? bundle.filesDeleted),
      filesUnchanged: Number(body.filesUnchanged ?? bundle.filesUnchanged),
      bytesSent: Number(body.bytesSent ?? bundle.bytesSent),
    };
  }

  exportThreadBundle(threadId: string): Promise<{ name: string; bundle: string }> {
    return this.exportBundle(threadId);
  }

  importThreadBundle(bundle: string): Promise<MoveResult> {
    return this.importBundle(bundle);
  }

  placementPolicy(): PlacementPolicy {
    return this.store.settings.remotePlacement ?? { enabled: false, targetId: "", idleSeconds: 60, consent: false };
  }

  /**
   * Automatic placement: pick idle worker sessions and cold-move them to the
   * selected user-owned runner. No per-session prompt. `force` is the explicit
   * "Place now" action and skips the idle timer and auto-enable checks.
   */
  async placeIdleSessions(force = false, onlyThreadId?: string): Promise<PlacementResult> {
    const policy = this.placementPolicy();
    const result: PlacementResult = { at: Date.now(), placed: [], skipped: [] };
    this.placementReport = result;
    if (!force && (!policy.enabled || !policy.consent)) {
      result.skipped.push(policy.enabled ? "consent missing" : "automatic placement disabled");
      return result;
    }
    if (!policy.targetId) {
      result.skipped.push("no target selected");
      return result;
    }
    const target = this.listTargets().find((item) => item.id === policy.targetId);
    if (!target) {
      result.skipped.push("selected target no longer exists");
      return result;
    }
    const token = this.targetToken(target.id);
    if (!token) {
      result.skipped.push("target token missing");
      return result;
    }
    try {
      const latency = await this.probe(target.url, token);
      this.saveTargets(this.listTargets().map((item) => (item.id === target.id ? { ...item, status: "online", latencyMs: latency, lastSeen: Date.now(), error: undefined } : item)));
      result.target = { id: target.id, name: target.name, status: "online" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.saveTargets(this.listTargets().map((item) => (item.id === target.id ? { ...item, status: "offline", error: message } : item)));
      result.skipped.push(`target offline: ${message}`);
      return result;
    }

    const now = Date.now();
    const idleMs = Math.max(5, policy.idleSeconds || 60) * 1000;
    const candidates = this.store.threads.filter((thread) => {
      if (onlyThreadId && thread.id !== onlyThreadId) return false;
      if (thread.targetId || thread.archived) return false;
      if (thread.kind !== "worker") return false;
      if (!["idle", "parked", "completed", "error", "cancelled"].includes(thread.status)) return false;
      if (!force && now - (thread.lastActivityAt || thread.updatedAt) < idleMs) return false;
      return this.store.getChat(thread.id).length > 0;
    });
    if (!candidates.length) {
      result.skipped.push("no idle worker sessions with history");
      return result;
    }
    const limit = force ? 5 : 2;
    for (const thread of candidates.sort((a, b) => a.lastActivityAt - b.lastActivityAt).slice(0, limit)) {
      const started = Date.now();
      try {
        const moved = await this.moveThread(thread.id, target.id);
        const updated = this.store.updateThread(thread.id, {
          targetId: target.id,
          remoteThreadId: moved.threadId,
          remoteNodeId: moved.nodeId,
          movedAt: Date.now(),
          status: "parked",
          statusMessage: `Placed on ${target.name}`,
        });
        this.orchestrator.notify({ type: "thread:updated", payload: updated });
        result.placed.push({ threadId: thread.id, targetId: target.id, remoteThreadId: moved.threadId, remoteNodeId: moved.nodeId, ms: Date.now() - started, warm: moved.warm, filesWritten: moved.filesWritten, filesUnchanged: moved.filesUnchanged, bytesSent: moved.bytesSent });
      } catch (error) {
        result.skipped.push(`${thread.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  lastPlacement(): PlacementResult | null {
    return this.placementReport;
  }

  /** Send stop/continue/compact or a prompt to a thread that lives on a target. */
  async proxyThreadAction(threadId: string, action: "send" | "stop" | "continue" | "compact", payload?: { text?: string }): Promise<boolean> {
    const thread = this.store.getThread(threadId);
    if (!thread?.targetId || !thread.remoteThreadId) return false;
    const target = this.listTargets().find((item) => item.id === thread.targetId);
    if (!target) throw new Error("The runner that owns this session is no longer registered");
    const token = this.targetToken(target.id);
    const response = await fetch(`${target.url}/api/threads/${encodeURIComponent(thread.remoteThreadId)}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(action === "send" ? { text: payload?.text ?? "" } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `Target returned HTTP ${response.status}`);
    }
    await this.syncRemoteThread(thread).catch(() => undefined);
    return true;
  }

  /** Mirror status, transcript and new messages for sessions placed on targets. */
  async syncRemoteThreads(): Promise<void> {
    const remoteThreads = this.store.threads.filter((thread) => thread.targetId && thread.remoteThreadId);
    await Promise.all(remoteThreads.slice(0, 8).map((thread) => this.syncRemoteThread(thread).catch(() => undefined)));
  }

  private async syncRemoteThread(thread: Thread): Promise<void> {
    if (!thread.targetId || !thread.remoteThreadId) return;
    const target = this.listTargets().find((item) => item.id === thread.targetId);
    if (!target) return;
    const token = this.targetToken(target.id);
    const response = await fetch(`${target.url}/api/threads/${encodeURIComponent(thread.remoteThreadId)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { thread?: Partial<Thread>; messages?: ChatMessage[] };
    const messages = (data.messages ?? []).map((message) => ({ ...message, threadId: thread.id }));
    const existing = this.store.getChat(thread.id);
    const seen = new Set(existing.map((message) => message.id));
    this.store.replaceChat(thread.id, messages);
    const remote = data.thread ?? {};
    const patch: Partial<Thread> = {};
    if (remote.status && remote.status !== thread.status) patch.status = remote.status;
    if ((remote.statusMessage ?? undefined) !== thread.statusMessage) patch.statusMessage = remote.statusMessage;
    if (remote.lastMessage !== undefined) patch.lastMessage = remote.lastMessage;
    if (remote.lastActivityAt) patch.lastActivityAt = remote.lastActivityAt;
    if (remote.unread !== undefined) patch.unread = remote.unread;
    if (remote.cost !== undefined && remote.cost !== thread.cost) patch.cost = remote.cost;
    if (remote.tokens !== undefined && remote.tokens !== thread.tokens) patch.tokens = remote.tokens;
    if (remote.contextTokens !== undefined) patch.contextTokens = remote.contextTokens;
    if (remote.contextWindow !== undefined) patch.contextWindow = remote.contextWindow;
    if (remote.model) patch.model = remote.model;
    if (Object.keys(patch).length) {
      const updated = this.store.updateThread(thread.id, patch);
      this.orchestrator.notify({ type: "thread:updated", payload: updated });
    }
    for (const message of messages) {
      if (!seen.has(message.id)) this.orchestrator.notify({ type: "thread:message", payload: message });
    }
  }


  private vapidKeys(): { publicKey: string; privateKey: string } {
    let publicKey = this.store.getSecret("remote.vapid.public");
    let privateKey = this.store.getSecret("remote.vapid.private");
    if (!publicKey || !privateKey) {
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
      this.store.setSecret("remote.vapid.public", publicKey);
      this.store.setSecret("remote.vapid.private", privateKey);
    }
    return { publicKey, privateKey };
  }

  private pushFile(): string {
    return join(this.store.baseDir, "push-subscriptions.json");
  }

  private loadPush(): Array<{ endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }> {
    if (this.pushSubscriptions) return this.pushSubscriptions;
    try {
      const parsed = JSON.parse(readFileSync(this.pushFile(), "utf8")) as unknown;
      this.pushSubscriptions = Array.isArray(parsed) ? (parsed as any[]) : [];
    } catch {
      this.pushSubscriptions = [];
    }
    return this.pushSubscriptions;
  }

  private savePush(subs: Array<{ endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }>): void {
    this.pushSubscriptions = subs.slice(-20);
    try {
      writeFileSync(this.pushFile(), JSON.stringify(this.pushSubscriptions), "utf8");
    } catch {
      /* push is best effort */
    }
  }

  usageReport(): RemoteUsage {
    const threads = this.store.threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      nodeId: thread.nodeId,
      status: thread.status,
      cost: Number(thread.cost ?? 0),
      tokens: Number(thread.tokens ?? 0),
    }));
    return {
      generatedAt: Date.now(),
      totalCost: threads.reduce((sum, thread) => sum + thread.cost, 0),
      totalTokens: threads.reduce((sum, thread) => sum + thread.tokens, 0),
      threads,
    };
  }

  async targetUsage(targetId: string): Promise<TargetUsage> {
    const target = this.listTargets().find((item) => item.id === targetId);
    if (!target) throw new Error("Target not found");
    const response = await fetch(`${target.url}/api/usage`, {
      headers: { authorization: `Bearer ${this.targetToken(targetId)}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Target usage failed with HTTP ${response.status}`);
    const usage = (await response.json()) as RemoteUsage;
    const updated: RemoteTarget = { ...target, cost: usage.totalCost, tokens: usage.totalTokens, usageAt: usage.generatedAt, lastSeen: Date.now() };
    this.saveTargets(this.listTargets().map((item) => (item.id === targetId ? updated : item)));
    return { ...usage, target: updated };
  }

  pushPublicKey(): { publicKey: string } {
    return { publicKey: this.vapidKeys().publicKey };
  }

  subscribePush(subscription: { endpoint?: string; expirationTime?: number | null; keys?: { p256dh?: string; auth?: string } }): { ok: boolean; count: number } {
    if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error("Invalid push subscription");
    const next = this.loadPush().filter((item) => item.endpoint !== subscription.endpoint);
    next.push({
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime ?? null,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    });
    this.savePush(next);
    return { ok: true, count: next.length };
  }

  unsubscribePush(endpoint: string): { ok: boolean; count: number } {
    const next = this.loadPush().filter((item) => item.endpoint !== endpoint);
    this.savePush(next);
    return { ok: true, count: next.length };
  }

  async sendPush(payload: { title: string; body: string; threadId?: string; tag?: string }): Promise<{ sent: number; failed: number; skipped: number; error?: string }> {
    const subs = this.loadPush();
    if (!subs.length) return { sent: 0, failed: 0, skipped: 1 };
    const { publicKey, privateKey } = this.vapidKeys();
    webpush.setVapidDetails("mailto:omp@localhost", publicKey, privateKey);
    let sent = 0;
    let failed = 0;
    let firstError = "";
    const dead = new Set<string>();
    await Promise.all(subs.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription as any, JSON.stringify(payload), { TTL: 300, urgency: "normal" });
        sent += 1;
      } catch (error) {
        failed += 1;
        if (!firstError) firstError = error instanceof Error ? error.message : String(error);
        const code = (error as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.add(subscription.endpoint);
      }
    }));
    if (dead.size) this.savePush(subs.filter((item) => !dead.has(item.endpoint)));
    return { sent, failed, skipped: 0, ...(firstError ? { error: firstError } : {}) };
  }

  private notifyPushForEvent(event: AppEvent): void {
    let payload: { title: string; body: string; threadId?: string; tag?: string } | null = null;
    if (event.type === "approval:request") {
      const request = event.payload;
      payload = { title: "Approval needed", body: request.title || "A session is waiting for your approval.", threadId: request.threadId, tag: `approval:${request.id}` };
    } else if (event.type === "thread:status" && ["waiting", "error"].includes(event.payload.status)) {
      const thread = this.store.getThread(event.payload.threadId);
      payload = {
        title: event.payload.status === "error" ? "Session failed" : "Session needs input",
        body: thread?.title ?? event.payload.message ?? "Open OMP to continue.",
        threadId: event.payload.threadId,
        tag: `status:${event.payload.threadId}:${event.payload.status}`,
      };
    } else if (event.type === "envelope:new" && event.payload.requiresResponse) {
      payload = { title: "Reply requested", body: event.payload.subject || "A session sent you a message.", threadId: event.payload.toThreadId, tag: `envelope:${event.payload.id}` };
    }
    if (!payload) return;
    void this.sendPush(payload).catch(() => undefined);
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
    this.notifyPushForEvent(event);
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
    if (parts[1] === "usage" && request.method === "GET") {
      return json(200, this.usageReport());
    }
    if (parts[1] === "push" && parts[2] === "key" && request.method === "GET") {
      return json(200, this.pushPublicKey());
    }
    if (parts[1] === "push" && parts[2] === "subscribe" && request.method === "POST") {
      const body = await readJson(request);
      return json(200, this.subscribePush(body as any));
    }
    if (parts[1] === "push" && parts[2] === "unsubscribe" && request.method === "POST") {
      const body = await readJson(request);
      return json(200, this.unsubscribePush(String(body.endpoint ?? "")));
    }
    if (parts[1] === "push" && parts[2] === "test" && request.method === "POST") {
      return json(200, await this.sendPush({ title: "OMP Remote", body: "Test notification from your runner.", tag: "test" }));
    }
    if (parts[1] === "workspace" && parts[2] && parts[3] === "manifest" && request.method === "GET") {
      const originKey = decodeURIComponent(parts[2]);
      const data = this.workspaceManifest(originKey);
      if (!data) return json(404, { error: "No warm workspace for this origin" });
      return json(200, { originKey, ...data });
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

  private hashFile(path: string): string {
    const info = statSync(path);
    const cached = this.fileHashes.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.hash;
    const hash = createHash("sha1").update(readFileSync(path)).digest("hex");
    this.fileHashes.set(path, { mtimeMs: info.mtimeMs, size: info.size, hash });
    return hash;
  }

  private async targetWorkspaceManifest(target: RemoteTarget, originKey: string): Promise<Map<string, string> | null> {
    try {
      const response = await fetch(`${target.url}/api/workspace/${encodeURIComponent(originKey)}/manifest`, {
        headers: { authorization: `Bearer ${this.targetToken(target.id)}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { files?: Record<string, { hash?: string }> };
      const map = new Map<string, string>();
      for (const [path, meta] of Object.entries(body.files ?? {})) if (meta?.hash) map.set(path, meta.hash);
      return map;
    } catch {
      return null;
    }
  }

  private workspaceRoot(thread: Thread, node: TreeNode): string {
    const worktree = thread.worktreePath;
    if (worktree && existsSync(worktree)) {
      try {
        if (readdirSync(worktree).some((name) => name !== ".git")) return worktree;
      } catch {
        /* fall through */
      }
    }
    return node.repoPath || node.path;
  }

  private async exportBundle(threadId: string, warmTarget?: { target: RemoteTarget; token: string }): Promise<{
    name: string;
    bundle: string;
    warm: boolean;
    filesWritten: number;
    filesUnchanged: number;
    filesDeleted: number;
    bytesSent: number;
  }> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const node = this.store.getNode(thread.nodeId);
    if (!node) throw new Error("Node not found");
    const zip = new JSZip();
    const cwd = this.workspaceRoot(thread, node);
    const chat = this.store.getChat(threadId);
    const originKey = node.id;
    const baseManifest = warmTarget ? await this.targetWorkspaceManifest(warmTarget.target, originKey) : null;
    const filesMeta: Record<string, { hash: string; size: number; mtimeMs: number }> = {};
    const seen = new Set<string>();
    let filesWritten = 0;
    let filesUnchanged = 0;
    let bytesSent = 0;
    const manifest: Record<string, unknown> = {
      format: "omp-session-v1",
      createdAt: Date.now(),
      originKey,
      node: { name: node.name, type: node.type, path: node.path, repoPath: node.repoPath, description: node.description, approvalMode: node.approvalMode, gitMode: node.gitMode },
      thread: { title: thread.title, kind: thread.kind, model: thread.model, effort: thread.effort, sessionFile: thread.sessionFile, todoPhases: thread.todoPhases, lastMessage: thread.lastMessage },
      chat,
    };
    let total = 0;
    const addWorkspace = (root: string) => {
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
          if (entry.name === ".omp-origin.json" || entry.name === ".omp-manifest.json") continue;
          const full = join(directory, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            try {
              const size = statSync(full).size;
              const rel = relative(root, full).replace(/\\/g, "/");
              seen.add(rel);
              if (size > 20 * 1024 * 1024) continue;
              const hash = this.hashFile(full);
              filesMeta[rel] = { hash, size, mtimeMs: statSync(full).mtimeMs };
              if (baseManifest && baseManifest.get(rel) === hash) {
                filesUnchanged += 1;
                continue;
              }
              total += size;
              bytesSent += size;
              filesWritten += 1;
              zip.file(`workspace/${rel}`, readFileSync(full));
            } catch {
              /* skip unreadable */
            }
          }
        }
      };
      walk(root);
    };
    const addSession = (root: string) => {
      const walk = (directory: string) => {
        let entries;
        try {
          entries = readdirSync(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = join(directory, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) {
            try {
              const rel = relative(root, full).replace(/\\/g, "/");
              filesWritten += 1;
              bytesSent += statSync(full).size;
              zip.file(`session/${rel}`, readFileSync(full));
            } catch {
              /* skip unreadable */
            }
          }
        }
      };
      walk(root);
    };
    let filesDeleted = 0;
    if (cwd && existsSync(cwd)) {
      addWorkspace(cwd);
      const deletions = baseManifest ? [...baseManifest.keys()].filter((path) => !seen.has(path)) : [];
      filesDeleted = deletions.length;
      (manifest as any).delta = baseManifest
        ? { originKey, base: true, deleted: deletions, changed: filesWritten, unchanged: filesUnchanged, bytes: bytesSent }
        : { originKey, base: false, changed: filesWritten, unchanged: 0, bytes: bytesSent };
      (manifest as any).filesMeta = filesMeta;
    }
    if (existsSync(thread.sessionDir)) addSession(thread.sessionDir);
    zip.file("manifest.json", JSON.stringify(manifest));
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    return {
      name: `${thread.title} (${node.name})`,
      bundle: buffer.toString("base64"),
      warm: !!baseManifest,
      filesWritten,
      filesUnchanged,
      filesDeleted,
      bytesSent,
    };
  }

  private findNodeByOrigin(originKey: string): TreeNode | null {
    for (const node of this.store.nodes) {
      if (!node.path) continue;
      const marker = join(node.path, ".omp-origin.json");
      if (!existsSync(marker)) continue;
      try {
        const data = JSON.parse(readFileSync(marker, "utf8")) as { originKey?: string };
        if (data.originKey === originKey) return node;
      } catch {
        /* ignore unreadable marker */
      }
    }
    return null;
  }

  private workspaceManifest(originKey: string): { nodeId: string; files: Record<string, { hash?: string; size?: number }> } | null {
    const node = this.findNodeByOrigin(originKey);
    if (!node?.path) return null;
    const file = join(node.path, ".omp-manifest.json");
    if (!existsSync(file)) return null;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { files?: Record<string, { hash?: string; size?: number }> };
      return { nodeId: node.id, files: data.files ?? {} };
    } catch {
      return null;
    }
  }

  private async importBundle(base64: string): Promise<MoveResult> {
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

    const originKey = typeof manifest.originKey === "string" ? manifest.originKey : "";
    const existing = originKey ? this.findNodeByOrigin(originKey) : null;
    const warm = !!existing && !!manifest.delta;
    const root = this.store.nodes.find((node) => node.type === "root");
    if (!root) throw new Error("Root node not found");
    const now = Date.now();
    const nodeId = existing?.id ?? newId("prj");
    const targetDir = existing?.path ?? join(this.store.baseDir, "workspaces", `imported-${nodeId}`);
    mkdirSync(targetDir, { recursive: true });

    let filesWritten = 0;
    let bytesWritten = 0;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (!name.startsWith("workspace/")) continue;
      const rel = name.slice("workspace/".length);
      if (!rel || rel.split("/").includes("..")) continue;
      const full = join(targetDir, rel);
      if (!normalize(full).startsWith(normalize(targetDir))) continue;
      mkdirSync(resolve(full, ".."), { recursive: true });
      const data = await entry.async("nodebuffer");
      writeFileSync(full, data);
      filesWritten += 1;
      bytesWritten += data.length;
    }
    const deletions: string[] = Array.isArray(manifest.delta?.deleted) ? manifest.delta.deleted : [];
    let filesDeleted = 0;
    for (const rel of deletions) {
      if (!rel || rel.split("/").includes("..")) continue;
      const full = join(targetDir, rel);
      if (!normalize(full).startsWith(normalize(targetDir))) continue;
      try {
        rmSync(full, { force: true });
        filesDeleted += 1;
      } catch {
        /* best effort */
      }
    }
    if (originKey) {
      writeFileSync(join(targetDir, ".omp-origin.json"), JSON.stringify({ originKey, updatedAt: now }));
      if (manifest.filesMeta) {
        writeFileSync(join(targetDir, ".omp-manifest.json"), JSON.stringify({ originKey, updatedAt: now, files: manifest.filesMeta }));
      }
    }

    let node: TreeNode;
    let orchestrator: Thread | null = null;
    if (existing) {
      node = this.store.updateNode(existing.id, { updatedAt: now });
    } else {
      node = {
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
      orchestrator = {
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
    }

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
    this.store.replaceChat(
      threadId,
      Array.isArray(manifest.chat) ? (manifest.chat as ChatMessage[]).map((message) => ({ ...message, threadId })) : [],
    );
    this.orchestrator.notify({ type: "node:updated", payload: node });
    if (orchestrator) this.orchestrator.notify({ type: "thread:updated", payload: orchestrator });
    this.orchestrator.notify({ type: "thread:updated", payload: imported });
    return {
      threadId,
      nodeId,
      warm,
      filesWritten,
      filesDeleted,
      filesUnchanged: Number(manifest.delta?.unchanged ?? 0),
      bytesSent: buffer.length,
    };
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

















