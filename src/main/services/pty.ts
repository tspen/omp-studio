import type { IPty } from "node-pty";
import { randomUUID } from "node:crypto";
import type { AppEvent, PtySession } from "../../shared/types";
import type { EnvironmentService } from "./environment";
import type { Store } from "./store";
import { audit } from "../audit";

const MAX_SESSIONS = 12;
const MAX_BUFFER = 600_000;
const URL_PATTERN = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))\b/gi;

interface Live {
  session: PtySession;
  proc: IPty;
  output: string;
  waiters: Array<(url: string | null) => void>;
}

export class PtyService {
  private store: Store;
  private environments: EnvironmentService;
  private emit: (event: AppEvent) => void;
  private onPreview: (url: string) => void;
  private live = new Map<string, Live>();

  constructor(store: Store, environments: EnvironmentService, emit: (event: AppEvent) => void, onPreview: (url: string) => void) {
    this.store = store;
    this.environments = environments;
    this.emit = emit;
    this.onPreview = onPreview;
  }

  list(): PtySession[] {
    return [...this.live.values()].map((item) => ({ ...item.session, urls: [...item.session.urls] }));
  }

  get(id: string): PtySession | undefined {
    const entry = this.live.get(id);
    return entry ? { ...entry.session, urls: [...entry.session.urls] } : undefined;
  }

  start(input: { nodeId?: string; threadId?: string; cols?: number; rows?: number; title?: string; shell?: string } = {}): PtySession {
    if (this.live.size >= MAX_SESSIONS) throw new Error(`Too many terminals are open (${MAX_SESSIONS}). Close one first.`);
    const thread = input.threadId ? this.store.getThread(input.threadId) : undefined;
    const nodeId = input.nodeId ?? thread?.nodeId ?? this.store.nodes.find((node) => node.type === "root")?.id;
    if (!nodeId) throw new Error("No node available for a terminal");
    const node = this.store.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const cwd = thread?.worktreePath || node.repoPath || node.path;
    const env = this.environments.resolveForNode(nodeId);
    const isWindows = process.platform === "win32";
    const shell = input.shell || this.store.settings.terminalShell || (isWindows ? "powershell.exe" : process.env.SHELL || "/bin/bash");
    const cols = Math.min(400, Math.max(20, input.cols || 100));
    const rows = Math.min(200, Math.max(5, input.rows || 30));
    const isPowerShell = /powershell|pwsh/i.test(shell);
    const proc = loadPty().spawn(shell, isPowerShell ? ["-NoLogo"] : [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...this.environments.envForProcess(env),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });
    const now = Date.now();
    const session: PtySession = {
      id: `pty_${randomUUID().replace(/-/g, "").slice(0, 12)}`,      nodeId,
      threadId: input.threadId,
      title: input.title || (isWindows ? "PowerShell" : shell.split("/").pop() || "Shell"),
      cwd,
      shell,
      status: "running",
      pid: proc.pid,
      createdAt: now,
      updatedAt: now,
      urls: [],
    };
    const live: Live = { session, proc, output: "", waiters: [] };
    this.live.set(session.id, live);
    audit("terminal-start", { sessionId: session.id, nodeId, cwd, shell });
    this.emit({ type: "pty:updated", payload: { ...session } });

    proc.onData((chunk) => {
      live.output = (live.output + chunk).slice(-MAX_BUFFER);
      this.emit({ type: "pty:data", payload: { sessionId: session.id, chunk } });
      const detected = this.detectUrls(session, chunk);
      for (const url of detected) {
        this.emit({ type: "pty:port", payload: { sessionId: session.id, url } });
        const waiters = live.waiters.splice(0);
        for (const resolve of waiters) resolve(url);
      }
      if (detected.length) this.emit({ type: "pty:updated", payload: { ...session, urls: [...session.urls] } });
    });
    proc.onExit(({ exitCode }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.updatedAt = Date.now();
      const waiters = live.waiters.splice(0);
      for (const resolve of waiters) resolve(null);
      this.emit({ type: "pty:updated", payload: { ...session, urls: [...session.urls] } });
    });
    return { ...session, urls: [] };
  }

  write(id: string, data: string): void {
    const live = this.live.get(id);
    if (!live || live.session.status !== "running") throw new Error("Terminal is not running");
    live.proc.write(data);
    live.session.updatedAt = Date.now();
  }

  resize(id: string, cols: number, rows: number): void {
    const live = this.live.get(id);
    if (!live || live.session.status !== "running") return;
    try {
      live.proc.resize(Math.min(400, Math.max(20, cols)), Math.min(200, Math.max(5, rows)));
    } catch {
      /* process may have just exited */
    }
  }

  read(id: string): string {
    return this.live.get(id)?.output ?? "";
  }

  kill(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    try {
      live.proc.kill();
    } catch {
      /* already gone */
    }
    live.session.status = "exited";
    live.session.updatedAt = Date.now();
    this.emit({ type: "pty:updated", payload: { ...live.session, urls: [...live.session.urls] } });
  }

  close(id: string): void {
    this.kill(id);
    this.live.delete(id);
  }

  async startDevServer(input: { nodeId?: string; threadId?: string; command: string }): Promise<{ session: PtySession; url?: string }> {
    const command = input.command.trim();
    if (!command) throw new Error("A command is required");
    this.assertAllowed(command);
    audit("dev-server-start", { nodeId: input.nodeId, threadId: input.threadId, command });
    const session = this.start({
      nodeId: input.nodeId,
      threadId: input.threadId,
      title: `dev · ${command.split(/\s+/).slice(0, 2).join(" ")}`.slice(0, 60),
    });
    const live = this.live.get(session.id)!;
    const urlPromise = new Promise<string | null>((resolve) => {
      live.waiters.push(resolve);
      const timer = setTimeout(() => {
        const index = live.waiters.indexOf(resolve);
        if (index >= 0) live.waiters.splice(index, 1);
        resolve(null);
      }, 30_000);
      timer.unref?.();
    });
    this.write(session.id, `${command}\r`);
    const url = await urlPromise;
    return { session: this.get(session.id) ?? session, url: url ?? this.get(session.id)?.urls[0] };
  }

  async stopDevServer(id: string): Promise<void> {
    this.kill(id);
  }

  disposeAll(): void {
    for (const id of [...this.live.keys()]) {
      try {
        this.live.get(id)?.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.live.clear();
  }

  private assertAllowed(command: string): void {
    const sandbox = this.store.settings.sandbox;
    if (!sandbox?.enabled) return;
    const lower = command.toLowerCase();
    const hit = (sandbox.deniedCommands ?? []).find((pattern) => pattern.trim() && lower.includes(pattern.trim().toLowerCase()));
    if (hit) {
      audit("sandbox-block", { command: command.slice(0, 500), pattern: hit });
      throw new Error(`Sandbox blocked this command: it matches "${hit}". Change the policy in Settings → Sandbox.`);
    }
  }

  private detectUrls(session: PtySession, chunk: string): string[] {
    const found: string[] = [];
    for (const match of chunk.matchAll(URL_PATTERN)) {
      const port = Number(match[1]);
      if (!Number.isFinite(port) || port < 1024 || port > 65535) continue;
      const url = `http://127.0.0.1:${port}/`;
      if (session.urls.includes(url) || found.includes(url)) continue;
      found.push(url);
    }
    if (!found.length) return found;
    const first = session.urls.length === 0;
    session.urls.push(...found);
    session.updatedAt = Date.now();
    if (first && this.store.settings.previewAutoOpen !== false) {
      setTimeout(() => this.onPreview(found[0]), 350);
    }
    return found;
  }
}

let cachedPty: typeof import("node-pty") | null = null;

/**
 * The desktop build ships node-pty. Headless Linux runners may not have a
 * usable native build, so loading is deferred and a missing module only
 * disables terminals instead of preventing the runner from starting.
 */
function loadPty(): typeof import("node-pty") {
  if (cachedPty) return cachedPty;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedPty = require("node-pty") as typeof import("node-pty");
    return cachedPty;
  } catch (error) {
    throw new Error(`Terminals are unavailable on this runner: ${error instanceof Error ? error.message : String(error)}`);
  }
}
