import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { trace } from "../diagnostics";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

export interface PiClientOptions {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args?: string[];
  onStderr?: (text: string) => void;
}

/**
 * Minimal JSONL client for `pi --mode rpc`.
 *
 * Pi's own RpcClient spawns the literal `node` binary, which is not present in
 * a packaged Electron install. This client uses the Electron binary in
 * ELECTRON_RUN_AS_NODE mode instead, and keeps the frame handling local so the
 * host bridge and session layer stay in one place.
 */
export class PiClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private stderr = "";
  private options: PiClientOptions;
  private stopped = false;

  constructor(options: PiClientOptions) {
    super();
    this.options = options;
  }

  get isRunning(): boolean {
    return !!this.child && this.child.exitCode === null && !this.stopped;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderrText(): string {
    return this.stderr;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Pi client is already started");
    const args = [this.options.cliPath, "--mode", "rpc", ...(this.options.args ?? [])];
    const child = spawn(process.execPath, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-20_000);
      this.options.onStderr?.(chunk);
      this.emit("stderr", chunk);
    });
    child.once("exit", (code, signal) => {
      if (this.stopped) return;
      const error = new Error(`Pi exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
      this.rejectAll(error);
      this.emit("exit", { code, signal, error });
    });
    child.once("error", (error) => {
      this.rejectAll(error);
      this.emit("error", error);
    });
    child.stdin.on("error", (error) => {
      if (this.stopped) return;
      this.rejectAll(error);
    });

    // Pi has no ready frame. get_state is the cheapest round trip that proves
    // the RPC loop is accepting commands.
    await this.request("get_state", {}, 30_000);
  }

  async request(type: string, payload: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<any> {
    if (!this.child || this.child.exitCode !== null) throw new Error("Pi is not running");
    const id = `perch-${++this.sequence}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi command timed out: ${type}${this.stderr ? `\n${this.stderr.slice(-2000)}` : ""}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: type });
      try {
        this.child!.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  sendRaw(payload: Record<string, unknown>): void {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async suspend(): Promise<void> {
    if (!this.child?.pid) throw new Error("Pi is not running");
    await setSuspended(this.child.pid, true);
  }

  async resume(): Promise<void> {
    if (!this.child?.pid) throw new Error("Pi is not running");
    await setSuspended(this.child.pid, false);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopped = true;
    this.child = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Pi stopped during ${pending.command}`));
      this.pending.delete(id);
    }
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    });
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        trace("pi-rpc-parse-failed", { bytes: line.length });
        continue;
      }
      this.handleFrame(frame);
    }
    if (this.buffer.length > 48 * 1024 * 1024) {
      trace("pi-rpc-buffer-drop", { mb: Math.round(this.buffer.length / 1_048_576) });
      this.buffer = "";
    }
  }

  private handleFrame(frame: any): void {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "response" && frame.id && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id)!;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.success === false) pending.reject(new Error(frame.error || `${pending.command} failed`));
      else pending.resolve(frame.data ?? {});
      return;
    }
    if (frame.type === "extension_ui_request") {
      this.emit("ui_request", frame);
      return;
    }
    this.emit("event", frame);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function setSuspended(pid: number, suspended: boolean): Promise<void> {
  if (process.platform !== "win32") {
    process.kill(pid, suspended ? "SIGSTOP" : "SIGCONT");
    return Promise.resolve();
  }
  const call = suspended ? "NtSuspendProcess" : "NtResumeProcess";
  const script = [
    "$sig = '[DllImport(\"ntdll.dll\")] public static extern int NtSuspendProcess(IntPtr h); [DllImport(\"ntdll.dll\")] public static extern int NtResumeProcess(IntPtr h);'",
    "Add-Type -MemberDefinition $sig -Name Nt -Namespace Win32 -ErrorAction SilentlyContinue | Out-Null",
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    `[Win32.Nt]::${call}($p.Handle) | Out-Null`,
  ].join("; ");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve();
    });
  });
}
