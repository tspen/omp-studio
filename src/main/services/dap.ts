import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface DapSession {
  key: string;
  child: ChildProcessWithoutNullStreams;
  buffer: Buffer;
  sequence: number;
  pending: Map<number, Pending>;
  events: any[];
  capabilities: any;
  stopped: any | null;
  exited: any | null;
  stderr: string;
}

const sessions = new Map<string, DapSession>();

function splitCommand(value: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of value.matchAll(pattern)) parts.push(match[1] ?? match[2] ?? match[3]);
  return parts;
}

function findCommand(command: string): string | null {
  if (isAbsolute(command) && existsSync(command)) return command;
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function adapterFor(input: DapLaunchInput): { command: string; args: string[]; id: string; shell: boolean } {
  const extension = extname(input.program || "").toLowerCase();
  const languageMap: Record<string, string> = {
    ".py": "python",
    ".go": "go",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
  };
  const language = String(input.language || languageMap[extension] || extension.replace(/^\./, "") || "").toLowerCase();
  const envKey = `PERCH_DAP_${language.toUpperCase()}`;
  const override = String(input.adapter || process.env[envKey] || "").trim();
  if (override) {
    const parts = splitCommand(override);
    if (!parts.length) throw new Error(`${envKey} is empty`);
    const command = findCommand(parts[0]);
    if (!command) throw new Error(`Debug adapter not found: ${parts[0]}`);
    return { command, args: parts.slice(1), id: language || "dap", shell: /\.(cmd|bat)$/i.test(command) };
  }
  const candidates: Record<string, Array<{ command: string; args: string[]; id: string }>> = {
    python: [{ command: "python", args: ["-m", "debugpy.adapter"], id: "debugpy" }],
    go: [{ command: "dlv", args: ["dap"], id: "go" }],
    c: [{ command: "lldb-vscode", args: [], id: "lldb" }],
    cpp: [{ command: "lldb-vscode", args: [], id: "lldb" }],
  };
  for (const candidate of candidates[language] ?? []) {
    const command = findCommand(candidate.command);
    if (command) return { command, args: candidate.args, id: candidate.id, shell: /\.(cmd|bat)$/i.test(command) };
  }
  throw new Error(
    `No debug adapter is configured for ${language || "this file"}. Install one or set ${envKey} / pass adapter.`,
  );
}

function send(session: DapSession, command: string, args: any, timeoutMs = 20_000): Promise<any> {
  const requestSeq = ++session.sequence;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      session.pending.delete(requestSeq);
      rejectPromise(new Error(`DAP ${command} timed out`));
    }, timeoutMs);
    session.pending.set(requestSeq, { resolve: resolvePromise, reject: rejectPromise, timer });
    const body = Buffer.from(JSON.stringify({ seq: requestSeq, type: "request", command, arguments: args }), "utf8");
    session.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    session.child.stdin.write(body);
  });
}

function handleData(session: DapSession, chunk: Buffer): void {
  session.buffer = Buffer.concat([session.buffer, chunk]);
  for (;;) {
    const headerEnd = session.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = session.buffer.subarray(0, headerEnd).toString("utf8");
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
    if (!length) {
      session.buffer = session.buffer.subarray(headerEnd + 4);
      continue;
    }
    if (session.buffer.length < headerEnd + 4 + length) break;
    const body = session.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    session.buffer = session.buffer.subarray(headerEnd + 4 + length);
    let message: any;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    if (message.type === "response") {
      const pending = session.pending.get(message.request_seq);
      if (!pending) continue;
      clearTimeout(pending.timer);
      session.pending.delete(message.request_seq);
      if (message.success === false) pending.reject(new Error(message.message || `DAP ${message.command} failed`));
      else pending.resolve(message.body ?? {});
    } else if (message.type === "event") {
      session.events.push(message);
      if (session.events.length > 1_000) session.events.splice(0, session.events.length - 1_000);
      if (message.event === "stopped") session.stopped = message.body ?? {};
      if (message.event === "exited") session.exited = message.body ?? {};
    }
  }
}

function waitForEvent(session: DapSession, name: string, timeoutMs: number): Promise<any> {
  const existing = session.events.find((event) => event.event === name);
  if (existing) return Promise.resolve(existing.body ?? {});
  return new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const event = session.events.find((item) => item.event === name);
      if (event) {
        clearInterval(timer);
        resolvePromise(event.body ?? {});
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        rejectPromise(new Error(`DAP event ${name} timed out`));
      }
    }, 75);
  });
}

export interface DapLaunchInput {
  threadId: string;
  cwd: string;
  program?: string;
  language?: string;
  adapter?: string;
  args?: string[];
  stopOnEntry?: boolean;
  timeoutMs?: number;
}

export async function dapLaunch(input: DapLaunchInput): Promise<any> {
  const key = input.threadId;
  const existing = sessions.get(key);
  if (existing && existing.child.exitCode === null) throw new Error("A debug session is already running. Stop it first.");
  const adapter = adapterFor(input);
  const program = input.program ? (isAbsolute(input.program) ? input.program : resolve(input.cwd, input.program)) : undefined;
  const child = spawn(adapter.command, adapter.args, {
    cwd: input.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: adapter.shell,
  });
  const session: DapSession = {
    key,
    child,
    buffer: Buffer.alloc(0),
    sequence: 0,
    pending: new Map(),
    events: [],
    capabilities: {},
    stopped: null,
    exited: null,
    stderr: "",
  };
  sessions.set(key, session);
  child.stdout.on("data", (chunk: Buffer) => handleData(session, chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    session.stderr = `${session.stderr}${chunk}`.slice(-8_000);
  });
  child.on("exit", (code) => {
    session.exited = { exitCode: code };
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Debug adapter exited with code ${code ?? "unknown"}${session.stderr ? `: ${session.stderr.trim()}` : ""}`));
    }
    session.pending.clear();
  });
  const timeoutMs = Math.max(1_000, Math.min(120_000, Number(input.timeoutMs) || 20_000));
  session.capabilities = await send(session, "initialize", {
    clientID: "perch",
    clientName: "Perch",
    adapterID: adapter.id,
    locale: "en-US",
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: "path",
  }, timeoutMs);
  const launchPromise = send(session, "launch", {
    program,
    cwd: input.cwd,
    args: input.args ?? [],
    stopOnEntry: input.stopOnEntry === true,
    noDebug: false,
  }, timeoutMs);
  await waitForEvent(session, "initialized", timeoutMs).catch(() => undefined);
  const configuration = send(session, "configurationDone", {}, timeoutMs).catch(() => undefined);
  await Promise.allSettled([launchPromise, configuration]);
  return {
    adapter: adapter.id,
    capabilities: session.capabilities,
    stopped: session.stopped,
    events: session.events.slice(-10),
  };
}

export interface DapInput {
  threadId: string;
  action: "breakpoints" | "continue" | "next" | "stepIn" | "stepOut" | "pause" | "threads" | "stack" | "scopes" | "variables" | "evaluate" | "status" | "stop";
  cwd?: string;
  path?: string;
  lines?: number[];
  threadIdForFrame?: number;
  frameId?: number;
  variablesReference?: number;
  expression?: string;
  context?: string;
  timeoutMs?: number;
}

export async function dapRequest(input: DapInput): Promise<any> {
  const session = sessions.get(input.threadId);
  if (!session) throw new Error("No debug session is running. Use launch first.");
  const timeoutMs = Math.max(1_000, Math.min(120_000, Number(input.timeoutMs) || 20_000));
  if (input.action === "status") {
    return {
      running: session.child.exitCode === null,
      stopped: session.stopped,
      exited: session.exited,
      events: session.events.slice(-20),
      stderr: session.stderr,
    };
  }
  if (input.action === "stop") {
    await send(session, "disconnect", { terminateDebuggee: true }, 5_000).catch(() => undefined);
    try {
      session.child.kill();
    } catch {
      /* ignore */
    }
    sessions.delete(input.threadId);
    return { stopped: true };
  }
  if (input.action === "breakpoints") {
    const root = input.cwd ? resolve(input.cwd) : process.cwd();
    const path = input.path ? (isAbsolute(input.path) ? input.path : resolve(root, input.path)) : "";
    if (!path) throw new Error("breakpoints needs path");
    const lines = (input.lines ?? []).map((line) => Math.max(1, Number(line) || 1));
    return send(session, "setBreakpoints", {
      source: { path, name: path.split(/[\\/]/).pop() },
      breakpoints: lines.map((line) => ({ line })),
      lines,
    }, timeoutMs);
  }
  if (input.action === "continue" || input.action === "next" || input.action === "stepIn" || input.action === "stepOut" || input.action === "pause") {
    const command = input.action === "stepIn" ? "stepIn" : input.action === "stepOut" ? "stepOut" : input.action;
    const threadId = Number(input.threadIdForFrame) || 1;
    session.stopped = null;
    await send(session, command, { threadId }, timeoutMs);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    return { command, threadId, stopped: session.stopped, events: session.events.slice(-10) };
  }
  if (input.action === "threads") return send(session, "threads", {}, timeoutMs);
  if (input.action === "stack") {
    const threadId = Number(input.threadIdForFrame) || 1;
    return send(session, "stackTrace", { threadId, startFrame: 0, levels: 50 }, timeoutMs);
  }
  if (input.action === "scopes") {
    if (input.frameId == null) throw new Error("scopes needs frameId");
    return send(session, "scopes", { frameId: Number(input.frameId) }, timeoutMs);
  }
  if (input.action === "variables") {
    if (input.variablesReference == null) throw new Error("variables needs variablesReference");
    return send(session, "variables", { variablesReference: Number(input.variablesReference) }, timeoutMs);
  }
  if (input.action === "evaluate") {
    if (!input.expression) throw new Error("evaluate needs expression");
    return send(session, "evaluate", {
      expression: input.expression,
      frameId: input.frameId == null ? undefined : Number(input.frameId),
      context: input.context || "repl",
    }, timeoutMs);
  }
  throw new Error(`Unknown debug action: ${input.action}`);
}

export function disposeDap(threadId?: string): void {
  const targets = threadId ? [threadId] : [...sessions.keys()];
  for (const key of targets) {
    const session = sessions.get(key);
    if (!session) continue;
    sessions.delete(key);
    try {
      session.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}
