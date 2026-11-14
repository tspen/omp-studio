import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface RpcReadyFrame {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
  supportsBashExcludeFromContext?: boolean;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

const MAX_FRAME = 80 * 1024 * 1024;

class FrameDecoder {
  private buffer = "";
  private chunks = new Map<string, { count: number; parts: Buffer[]; byteLength: number }>();
  private onObject: (value: any) => void;

  constructor(onObject: (value: any) => void) {
    this.onObject = onObject;
  }

  push(data: Buffer | string): void {
    this.buffer += data.toString();
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (line.length > 4_000_000) {
        console.error(`[rpc] large frame ${(line.length / 1_048_576).toFixed(1)}MB type=${frame?.type ?? "?"}`);
      }
      if (frame?.type === "rpc_chunk") {
        this.acceptChunk(frame);
      } else {
        this.onObject(frame);
      }
    }
    if (this.buffer.length > MAX_FRAME) {
      this.buffer = "";
    }
  }

  private acceptChunk(frame: any): void {
    const chunkId = String(frame.chunkId ?? "");
    const index = Number(frame.index);
    const count = Number(frame.count);
    if (!chunkId || !Number.isInteger(index) || !Number.isInteger(count) || index < 0 || count < 1) return;
    let entry = this.chunks.get(chunkId);
    if (!entry) {
      entry = { count, parts: new Array(count), byteLength: Number(frame.byteLength) || 0 };
      this.chunks.set(chunkId, entry);
    }
    if (entry.count !== count) return;
    try {
      entry.parts[index] = Buffer.from(String(frame.data ?? ""), "base64");
    } catch {
      this.chunks.delete(chunkId);
      return;
    }
    if (entry.parts.filter(Boolean).length !== count) return;
    this.chunks.delete(chunkId);
    const buffer = Buffer.concat(entry.parts);
    if (buffer.length > MAX_FRAME) return;
    if (buffer.length > 4_000_000) console.error(`[rpc] large reassembled frame ${(buffer.length / 1_048_576).toFixed(1)}MB`);
    try {
      const logical = JSON.parse(buffer.toString("utf8"));
      this.onObject(logical);
    } catch {
      /* ignore corrupt chunk assembly */
    }
  }
}

export interface RpcClientOptions {
  exe: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStderr?: (text: string) => void;
}

export class RpcClient extends EventEmitter {
  readonly options: RpcClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder: FrameDecoder;
  private pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private ready: RpcReadyFrame | null = null;
  private stderr = "";
  private closed = false;
  private startPromise: Promise<RpcReadyFrame> | null = null;

  constructor(options: RpcClientOptions) {
    super();
    this.options = options;
    this.decoder = new FrameDecoder((frame) => this.handleFrame(frame));
  }

  get isRunning(): boolean {
    return !!this.child && !this.closed;
  }

  get readyInfo(): RpcReadyFrame | null {
    return this.ready;
  }

  get stderrText(): string {
    return this.stderr;
  }

  start(timeoutMs = 45_000): Promise<RpcReadyFrame> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<RpcReadyFrame>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`OMP did not become ready in ${Math.round(timeoutMs / 1000)}s. ${this.stderr.slice(-1200)}`));
        this.kill();
      }, timeoutMs);

      try {
        this.child = spawn(this.options.exe, this.options.args, {
          cwd: this.options.cwd,
          env: this.options.env,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        clearTimeout(timer);
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      this.child.stdout.on("data", (data: Buffer) => this.decoder.push(data));
      this.child.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        this.stderr = (this.stderr + text).slice(-24_000);
        this.options.onStderr?.(text);
      });
      this.child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
        this.failAll(error);
        this.emit("error", error);
      });
      this.child.on("exit", (code, signal) => {
        this.closed = true;
        this.failAll(new Error(`OMP exited (code ${code ?? "null"}, signal ${signal ?? "none"}). ${this.stderr.slice(-1200)}`));
        this.emit("exit", { code, signal });
      });

      const readyHandler = (frame: RpcReadyFrame) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = frame;
        // Prefer lossless v2 framing. Older runtimes simply do not advertise it.
        if (frame.supportedProtocolVersions?.includes(2)) {
          this.request("negotiate_protocol", { protocolVersion: 2 }, 10_000).catch(() => undefined);
        }
        resolve(frame);
      };
      this.once("ready", readyHandler);
    });
    return this.startPromise;
  }

  request<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.child || this.closed) return Promise.reject(new Error("OMP session is not running"));
    const id = `req_${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OMP command ${type} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: type });
      this.write({ id, type, ...payload });
    });
  }

  sendRaw(frame: Record<string, unknown>): void {
    this.write(frame);
  }

  interrupt(): void {
    if (!this.child) return;
    if (process.platform === "win32") {
      this.child.kill("SIGINT");
    } else {
      this.child.kill("SIGINT");
    }
  }

  async close(graceMs = 2500): Promise<void> {
    const child = this.child;
    if (!child || this.closed) {
      this.closed = true;
      return;
    }
    this.closed = true;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.failAll(new Error("OMP session closed"));
  }

  kill(): void {
    this.closed = true;
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
    this.failAll(new Error("OMP session killed"));
  }

  private write(frame: Record<string, unknown>): void {
    if (!this.child || this.closed) throw new Error("OMP stdin is closed");
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private handleFrame(frame: any): void {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "ready") {
      this.emit("ready", frame);
      return;
    }
    if (frame.type === "response") {
      const pending = frame.id ? this.pending.get(frame.id) : undefined;
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.success) pending.resolve(frame.data ?? {});
        else {
          const error = new Error(frame.error ?? `OMP command ${frame.command} failed`);
          (error as any).code = frame.code;
          pending.reject(error);
        }
      }
      this.emit("response", frame);
      return;
    }
    if (frame.type === "rpc_frame_error") {
      this.emit("frame_error", frame);
      return;
    }
    this.emit("frame", frame);
    this.emit(frame.type, frame);
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
