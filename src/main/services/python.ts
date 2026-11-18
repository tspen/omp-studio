import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface PythonResult {
  stdout: string;
  stderr: string;
  result: string | null;
}

interface Pending {
  resolve: (value: PythonResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Worker {
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  stderr: string;
  pending: Map<number, Pending>;
}

const BOOTSTRAP = String.raw`
import ast
import contextlib
import io
import json
import sys
import traceback

_namespace = {"__name__": "__main__"}

def _execute(code):
    stdout = io.StringIO()
    stderr = io.StringIO()
    value = None
    try:
        tree = ast.parse(code, "<perch>", "exec")
        body = tree.body[:-1]
        last = tree.body[-1] if tree.body else None
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if body:
                module = ast.Module(body=body, type_ignores=[])
                ast.fix_missing_locations(module)
                exec(compile(module, "<perch>", "exec"), _namespace)
            if last is not None:
                expression = ast.Expression(body=last.value) if isinstance(last, ast.Expr) else None
                if expression is not None:
                    ast.fix_missing_locations(expression)
                    value = eval(compile(expression, "<perch>", "eval"), _namespace)
                else:
                    module = ast.Module(body=[last], type_ignores=[])
                    ast.fix_missing_locations(module)
                    exec(compile(module, "<perch>", "exec"), _namespace)
    except BaseException:
        traceback.print_exc(file=stderr)
    if value is not None:
        print(repr(value), file=stdout)
    return stdout.getvalue(), stderr.getvalue(), None if value is None else repr(value)

for line in sys.stdin:
    try:
        request = json.loads(line)
        stdout, stderr, value = _execute(request.get("code", ""))
        response = {"id": request.get("id"), "stdout": stdout, "stderr": stderr, "result": value}
    except BaseException as error:
        response = {"id": None, "stdout": "", "stderr": str(error), "result": None}
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
`;

let commandCache: { command: string; args: string[] } | null = null;

function pythonCommand(): { command: string; args: string[] } {
  if (commandCache) return commandCache;
  const configured = process.env.PERCH_PYTHON?.trim();
  const candidates = configured
    ? [{ command: configured, args: [] as string[] }]
    : process.platform === "win32"
      ? [
          { command: "python", args: [] as string[] },
          { command: "python3", args: [] as string[] },
          { command: "py", args: ["-3"] },
        ]
      : [
          { command: "python3", args: [] as string[] },
          { command: "python", args: [] as string[] },
        ];
  for (const candidate of candidates) {
    const check = spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!check.error && check.status === 0) {
      commandCache = candidate;
      return candidate;
    }
  }
  throw new Error("Python 3 is required for the python and notebook tools. Install Python or set PERCH_PYTHON.");
}

export class PythonService {
  private workers = new Map<string, Worker>();
  private sequence = 0;

  async execute(key: string, cwd: string, code: string, timeoutMs = 30_000): Promise<PythonResult> {
    if (!code.trim()) throw new Error("Python code is empty");
    const worker = this.worker(key, cwd);
    const id = ++this.sequence;
    const timeout = Math.max(1_000, Math.min(120_000, Number(timeoutMs) || 30_000));
    return new Promise<PythonResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        this.kill(key);
        reject(new Error(`Python timed out after ${timeout}ms`));
      }, timeout);
      worker.pending.set(id, { resolve, reject, timer });
      worker.child.stdin.write(`${JSON.stringify({ id, code })}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        worker.pending.delete(id);
        reject(error);
      });
    });
  }

  reset(key: string): boolean {
    return this.kill(key);
  }

  dispose(): void {
    for (const key of [...this.workers.keys()]) this.kill(key);
  }

  private worker(key: string, cwd: string): Worker {
    const existing = this.workers.get(key);
    if (existing && existing.child.exitCode === null && !existing.child.killed) return existing;
    if (existing) this.kill(key);
    const command = pythonCommand();
    const child = spawn(command.command, [...command.args, "-u", "-c", BOOTSTRAP], {
      cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const worker: Worker = { child, buffer: "", stderr: "", pending: new Map() };
    this.workers.set(key, worker);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(worker, chunk));
    child.stderr.on("data", (chunk: string) => {
      worker.stderr = `${worker.stderr}${chunk}`.slice(-16_000);
    });
    child.on("error", (error) => this.fail(worker, error));
    child.on("exit", (code) => {
      this.workers.delete(key);
      this.fail(worker, new Error(`Python exited with code ${code ?? "unknown"}${worker.stderr ? `: ${worker.stderr.trim()}` : ""}`));
    });
    return worker;
  }

  private handleStdout(worker: Worker, chunk: string): void {
    worker.buffer += chunk;
    for (;;) {
      const newline = worker.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = worker.buffer.slice(0, newline).trim();
      worker.buffer = worker.buffer.slice(newline + 1);
      if (!line) continue;
      let payload: any;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = worker.pending.get(payload.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      worker.pending.delete(payload.id);
      pending.resolve({
        stdout: String(payload.stdout ?? ""),
        stderr: String(payload.stderr ?? ""),
        result: payload.result == null ? null : String(payload.result),
      });
    }
  }

  private fail(worker: Worker, error: Error): void {
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    worker.pending.clear();
  }

  private kill(key: string): boolean {
    const worker = this.workers.get(key);
    if (!worker) return false;
    this.workers.delete(key);
    this.fail(worker, new Error("Python kernel stopped"));
    try {
      worker.child.kill();
    } catch {
      /* ignore */
    }
    return true;
  }
}
