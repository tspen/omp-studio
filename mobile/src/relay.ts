export interface RelayConfig {
  relay: string;
  room: string;
  token: string;
  key: string;
}

interface Pending {
  resolve: (value: { status: number; body: string }) => void;
  reject: (error: Error) => void;
  timer: number;
}

function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export function relayConfigFromHash(): RelayConfig | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const encoded = params.get("r");
  if (encoded) {
    try {
      const config = JSON.parse(fromBase64Url(encoded)) as RelayConfig;
      if (config?.relay && config?.room && config?.token && config?.key) {
        localStorage.setItem("omp.relay", JSON.stringify(config));
        return config;
      }
    } catch {
      /* ignore malformed relay link */
    }
  }
  try {
    const stored = JSON.parse(localStorage.getItem("omp.relay") || "null") as RelayConfig | null;
    return stored?.relay && stored?.room && stored?.token && stored?.key ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Browser side of the E2E relay transport. HTTP requests and events are
 * AES-256-GCM encrypted with a key derived from the pairing fragment; the relay
 * only sees opaque frames.
 */
export class RelayTransport {
  private config: RelayConfig;
  private socket: WebSocket | null = null;
  private key: CryptoKey | null = null;
  private pending = new Map<string, Pending>();
  private connecting: Promise<void> | null = null;
  private onEvent: (event: any) => void;
  private onStatus: (connected: boolean, detail?: string) => void;

  constructor(config: RelayConfig, onEvent: (event: any) => void, onStatus: (connected: boolean, detail?: string) => void) {
    this.config = config;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  private async ensureKey(): Promise<CryptoKey> {
    if (this.key) return this.key;
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.config.key), "HKDF", false, ["deriveKey"]);
    this.key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("omp-relay-v1"), info: new TextEncoder().encode("omp-relay-e2e") },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return this.key;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const base = this.config.relay.replace(/\/+$/, "").replace(/^http/, "ws");
      const url = `${base}/ws?role=client&room=${encodeURIComponent(this.config.room)}&token=${encodeURIComponent(this.config.token)}`;
      const socket = new WebSocket(url);
      this.socket = socket;
      const timer = window.setTimeout(() => {
        reject(new Error("Relay connection timed out"));
        socket.close();
      }, 12_000);
      socket.onopen = () => {
        window.clearTimeout(timer);
        this.onStatus(true);
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timer);
        this.onStatus(false, "Relay connection failed");
        reject(new Error("Relay connection failed"));
      };
      socket.onclose = () => {
        window.clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        this.onStatus(false);
        for (const pending of this.pending.values()) {
          window.clearTimeout(pending.timer);
          pending.reject(new Error("Relay disconnected"));
        }
        this.pending.clear();
      };
      socket.onmessage = (event) => void this.handle(String(event.data));
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async handle(raw: string): Promise<void> {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.t === "relay") {
      this.onStatus(message.state === "online" || message.state === "ready");
      return;
    }
    if (message.t !== "frame" || typeof message.data !== "string") return;
    let payload: any;
    try {
      payload = await this.decrypt(message.data);
    } catch {
      return;
    }
    if (payload?.t === "event" && payload.event) {
      this.onEvent(payload.event);
      return;
    }
    if (payload?.t === "res" && payload.id && this.pending.has(payload.id)) {
      const pending = this.pending.get(payload.id)!;
      window.clearTimeout(pending.timer);
      this.pending.delete(payload.id);
      pending.resolve({ status: Number(payload.status ?? 500), body: String(payload.body ?? "") });
    }
  }

  async request(path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Relay is offline");
    const key = await this.ensureKey();
    const id = crypto.randomUUID();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const frame = await this.encrypt({ t: "req", id, method: init?.method ?? "GET", path, body }, key);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Relay request timed out"));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ data: frame }));
    });
  }

  private async encrypt(payload: unknown, key: CryptoKey): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
    return JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(encrypted) });
  }

  private async decrypt(frame: string): Promise<any> {
    const key = await this.ensureKey();
    const parsed = JSON.parse(frame) as { v?: number; iv?: string; data?: string };
    if (parsed.v !== 1 || !parsed.iv || !parsed.data) throw new Error("Bad frame");
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(parsed.iv) }, key, fromBase64(parsed.data));
    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  close(): void {
    this.socket?.close(1000, "client closed");
    this.socket = null;
  }
}
