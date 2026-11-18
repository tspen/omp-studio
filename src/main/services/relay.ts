import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { WebSocket } from "ws";
import type { AppEvent, RelayInfo, RelayInput } from "../../shared/types";
import type { Store } from "./store";

/**
 * Runner side of the self-hosted relay. It dials out, authenticates with the
 * room token, and exchanges AES-256-GCM frames with paired clients. The relay
 * only sees ciphertext and routing metadata.
 */
export class RelayService {
  private store: Store;
  private socket: WebSocket | null = null;
  private key: Buffer | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private clients = 0;
  private connected = false;
  private lastError: string | undefined;

  constructor(store: Store) {
    this.store = store;
  }

  private config(): { enabled: boolean; url: string; room: string; token: string; secret: string } {
    const settings = this.store.settings.remoteRelay;
    return {
      enabled: process.env.PERCH_RELAY_URL ? true : !!settings?.enabled,
      url: (process.env.PERCH_RELAY_URL || settings?.url || "").replace(/\/+$/, ""),
      room: process.env.PERCH_RELAY_ROOM || settings?.room || "",
      token: process.env.PERCH_RELAY_TOKEN || this.store.getSecret("remote.relay.token") || "",
      secret: process.env.PERCH_RELAY_SECRET || this.store.getSecret("remote.relay.secret") || "",
    };
  }

  async info(): Promise<RelayInfo> {
    const config = this.config();
    const link = config.enabled && config.url && config.room && config.token && config.secret
      ? `${config.url}/#r=${base64url(JSON.stringify({ relay: config.url, room: config.room, token: config.token, key: config.secret }))}`
      : undefined;
    const qr = link ? await QRCode.toDataURL(link, { margin: 1, width: 280 }).catch(() => undefined) : undefined;
    return {
      enabled: config.enabled,
      running: !!this.socket,
      connected: this.connected,
      url: config.url,
      room: config.room,
      clients: this.clients,
      hasToken: !!config.token,
      hasSecret: !!config.secret,
      link,
      qr,
      error: this.lastError,
    };
  }

  async configure(input: RelayInput): Promise<RelayInfo> {
    const url = normalizeUrl(input.url);
    const room = input.room.trim() || `perch-${randomBytes(4).toString("hex")}`;
    const token = input.token.trim() || this.store.getSecret("remote.relay.token") || randomBytes(24).toString("hex");
    const secret = input.secret.trim() || this.store.getSecret("remote.relay.secret") || randomBytes(32).toString("hex");
    this.store.setSecret("remote.relay.token", token);
    this.store.setSecret("remote.relay.secret", secret);
    this.store.setSettings({ remoteRelay: { enabled: input.enabled, url, room } });
    await this.stop(false);
    if (input.enabled) await this.start();
    return this.info();
  }

  async start(): Promise<RelayInfo> {
    const config = this.config();
    if (!config.url || !config.room || !config.token || !config.secret) {
      this.lastError = "Relay URL, room, token and secret are required";
      return this.info();
    }
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(config.secret), Buffer.from("perch-relay-v1"), Buffer.from("perch-relay-e2e"), 32));
    this.stopped = false;
    this.connect(config);
    return this.info();
  }

  async stop(persist = true): Promise<RelayInfo> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.connected = false;
    if (this.socket) {
      try {
        this.socket.close(1000, "relay stopped");
      } catch {
        /* ignore */
      }
    }
    this.socket = null;
    if (persist) this.store.setSettings({ remoteRelay: { ...this.store.settings.remoteRelay, enabled: false } });
    return this.info();
  }

  private connect(config: { url: string; room: string; token: string }): void {
    const wsUrl = `${config.url.replace(/^http/, "ws")}/ws?role=runner&room=${encodeURIComponent(config.room)}&token=${encodeURIComponent(config.token)}`;
    const socket = new WebSocket(wsUrl, { handshakeTimeout: 15_000, maxPayload: 32 * 1024 * 1024 });
    this.socket = socket;
    socket.on("open", () => {
      this.connected = true;
      this.lastError = undefined;
    });
    socket.on("message", (data) => void this.handleMessage(String(data)));
    socket.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    socket.on("close", () => {
      this.connected = false;
      this.clients = 0;
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      this.retry = setTimeout(() => {
        if (!this.stopped) this.start().catch(() => undefined);
      }, 3_000);
      this.retry.unref?.();
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: { from?: string; data?: string; t?: string; state?: string; clients?: number };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.t === "relay") {
      this.clients = Number(message.clients ?? 0);
      if (message.state === "offline") this.clients = 0;
      return;
    }
    if (message.t === "client-open") {
      this.clients += 1;
      return;
    }
    if (message.t === "client-close") {
      this.clients = Math.max(0, this.clients - 1);
      return;
    }
    if (!message.from || !message.data) return;
    let request: { t?: string; id?: string; method?: string; path?: string; body?: string };
    try {
      request = this.decrypt(message.data);
    } catch {
      return;
    }
    if (request.t !== "req" || !request.id || !request.path) return;
    const response = await this.localRequest(request.method ?? "GET", request.path, request.body);
    this.sendTo(message.from, { t: "res", id: request.id, status: response.status, body: response.body });
  }

  private async localRequest(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
    if (!path.startsWith("/api/")) return { status: 400, body: JSON.stringify({ error: "Relay only proxies the runner API" }) };
    const token = process.env.PERCH_REMOTE_TOKEN || this.store.getSecret("remote.token") || "";
    const port = this.store.settings.remote.port || 43120;
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: method === "GET" || method === "HEAD" ? undefined : body || "{}",
        signal: AbortSignal.timeout(120_000),
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { status: 502, body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) };
    }
  }

  publish(event: AppEvent): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.key) return;
    this.sendTo("*", { t: "event", event });
  }

  private sendTo(to: string, payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({ to, data: this.encrypt(payload) }));
    } catch {
      /* reconnect will handle it */
    }
  }

  private encrypt(payload: unknown): string {
    if (!this.key) throw new Error("Relay key is not ready");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({ v: 1, iv: iv.toString("base64"), data: Buffer.concat([encrypted, tag]).toString("base64") });
  }

  private decrypt(frame: string): any {
    if (!this.key) throw new Error("Relay key is not ready");
    const parsed = JSON.parse(frame) as { v?: number; iv?: string; data?: string };
    if (parsed.v !== 1 || !parsed.iv || !parsed.data) throw new Error("Bad frame");
    const buffer = Buffer.from(parsed.data, "base64");
    const iv = Buffer.from(parsed.iv, "base64");
    const tag = buffer.subarray(buffer.length - 16);
    const data = buffer.subarray(0, buffer.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
  }
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("A relay URL is required");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}




