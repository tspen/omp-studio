import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AppEvent, TerminalRun } from "../../shared/types";
import type { EnvironmentService } from "./environment";
import type { Store } from "./store";

export class TerminalService {
  private store: Store;
  private environments: EnvironmentService;
  private emit: (event: AppEvent) => void;
  private running = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(store: Store, environments: EnvironmentService, emit: (event: AppEvent) => void) {
    this.store = store;
    this.environments = environments;
    this.emit = emit;
  }

  list(): TerminalRun[] {
    return this.store.data.terminals;
  }

  run(input: { nodeId: string; threadId?: string; command: string }): TerminalRun {
    const node = this.store.getNode(input.nodeId);
    if (!node) throw new Error(`Node not found: ${input.nodeId}`);
    const thread = input.threadId ? this.store.getThread(input.threadId) : undefined;
    const cwd = thread?.worktreePath || node.repoPath || node.path;
    const env = this.environments.resolveForNode(input.nodeId);
    const run: TerminalRun = {
      id: `term_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      nodeId: input.nodeId,
      threadId: input.threadId,
      cwd,
      command: input.command,
      status: "running",
      output: "",
      startedAt: Date.now(),
    };
    this.store.addTerminal(run);
    this.emit({ type: "terminal:updated", payload: run });

    const isWindows = process.platform === "win32";
    const shell = env?.shell || (isWindows ? process.env.ComSpec || "cmd.exe" : "/bin/sh");
    const args = isWindows ? ["/d", "/s", "/c", input.command] : ["-lc", input.command];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shell, args, {
        cwd,
        env: this.environments.envForProcess(env),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.finish(run.id, "error", 1, `\n${String(error)}\n`);
      return this.store.data.terminals.find((r) => r.id === run.id)!;
    }
    this.running.set(run.id, child);
    const append = (chunk: string) => {
      const current = this.store.data.terminals.find((r) => r.id === run.id);
      if (!current) return;
      current.output = (current.output + chunk).slice(-300_000);
      this.emit({ type: "terminal:output", payload: { runId: run.id, chunk } });
    };
    child.stdout.on("data", (data: Buffer) => append(data.toString()));
    child.stderr.on("data", (data: Buffer) => append(data.toString()));
    child.on("close", (code) => {
      this.running.delete(run.id);
      this.finish(run.id, code === 0 ? "done" : "error", code ?? 1);
    });
    child.on("error", (error) => {
      this.running.delete(run.id);
      append(`${error.message}\n`);
      this.finish(run.id, "error", 1);
    });
    return run;
  }

  kill(runId: string): void {
    const child = this.running.get(runId);
    if (!child) return;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    this.running.delete(runId);
    this.finish(runId, "cancelled", undefined);
  }

  private finish(runId: string, status: TerminalRun["status"], exitCode?: number, extra?: string): void {
    const run = this.store.updateTerminal(runId, { status, exitCode, endedAt: Date.now() });
    if (!run) return;
    if (extra) run.output = (run.output + extra).slice(-300_000);
    this.emit({ type: "terminal:updated", payload: run });
    this.emit({ type: "terminal:output", payload: { runId, chunk: "", done: true, exitCode } });
  }
}
