import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AstEditInput, AstEditResult, AstGrepInput, AstMatch, AstResult } from "./ast";

const NAPI_LANGUAGES = new Set([
  "typescript",
  "ts",
  "tsx",
  "javascript",
  "js",
  "jsx",
  "html",
  "htm",
  "css",
]);

export const CLI_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".sh": "bash",
  ".bash": "bash",
  ".lua": "lua",
  ".ex": "elixir",
  ".exs": "elixir",
  ".hs": "haskell",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
};

export function cliLanguage(input: { lang?: string; path?: string }): string | null {
  const requested = input.lang?.trim().toLowerCase();
  if (requested) return requested;
  const extension = extname(input.path || "").toLowerCase();
  return CLI_LANGUAGE_BY_EXTENSION[extension] ?? null;
}

export function wantsCli(input: { lang?: string; path?: string }): boolean {
  const requested = input.lang?.trim().toLowerCase();
  if (requested) return !NAPI_LANGUAGES.has(requested) && requested !== "python" && requested !== "py";
  if (!input.path) return false;
  return extname(input.path).toLowerCase() in CLI_LANGUAGE_BY_EXTENSION;
}

function platformPackages(): string[] {
  if (process.platform === "win32") {
    if (process.arch === "arm64") return ["cli-win32-arm64-msvc"];
    if (process.arch === "ia32") return ["cli-win32-ia32-msvc"];
    return ["cli-win32-x64-msvc"];
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? ["cli-darwin-arm64"] : ["cli-darwin-x64"];
  }
  if (process.arch === "arm64") return ["cli-linux-arm64-gnu", "cli-linux-arm64-musl"];
  return ["cli-linux-x64-gnu", "cli-linux-x64-musl"];
}

function cliCandidates(): string[] {
  const binaries = process.platform === "win32" ? ["sg.exe", "ast-grep.exe"] : ["sg", "ast-grep"];
  const roots = [
    process.resourcesPath ? join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@ast-grep") : "",
    join(process.cwd(), "node_modules", "@ast-grep"),
  ].filter(Boolean);
  const candidates: string[] = [];
  for (const root of roots) {
    for (const platformPackage of platformPackages()) {
      for (const binary of binaries) candidates.push(join(root, platformPackage, binary));
    }
    for (const binary of binaries) candidates.push(join(root, "cli", binary));
  }
  return candidates;
}

function cliPath(): string {
  const found = cliCandidates().find((candidate) => existsSync(candidate));
  if (!found) throw new Error("The bundled ast-grep CLI is not installed");
  return found;
}

function isInside(root: string, target: string): boolean {
  const base = resolve(root);
  const path = resolve(target);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cliPath(), args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("ast-grep CLI timed out"));
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function cleanStderr(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^=+$/.test(line) && !/WARNING: `sg` is deprecated/i.test(line))
    .join("\n")
    .trim();
}

interface CliMatch extends AstMatch {
  start: number;
  end: number;
  replacement: string;
}

function mapMatch(item: any, root: string): CliMatch | null {
  if (!item || typeof item !== "object") return null;
  const file = typeof item.file === "string" ? item.file : "";
  if (!file) return null;
  const absolute = isAbsolute(file) ? file : resolve(root, file);
  const path = relative(root, absolute).split(sep).join("/");
  const range = item.range ?? {};
  const startLine = Number(range.start?.line ?? 0);
  const startColumn = Number(range.start?.column ?? 0);
  const endLine = Number(range.end?.line ?? startLine);
  const endColumn = Number(range.end?.column ?? startColumn);
  const captures: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(item.metaVariables?.single ?? {})) {
    const text = (value as any)?.text;
    if (typeof text === "string") captures[name] = text;
  }
  for (const [name, value] of Object.entries(item.metaVariables?.multi ?? {})) {
    if (Array.isArray(value)) captures[name] = value.map((entry: any) => String(entry?.text ?? ""));
  }
  const offsets = item.replacementOffsets ?? range.byteOffset ?? {};
  const start = Number(offsets.start);
  const end = Number(offsets.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const replacement = typeof item.replacement === "string" ? item.replacement : String(item.text ?? "");
  return {
    path,
    line: startLine + 1,
    column: startColumn + 1,
    endLine: endLine + 1,
    endColumn: endColumn + 1,
    text: replacement,
    captures,
    start,
    end,
    replacement,
  };
}

async function cliMatches(input: AstGrepInput, rewrite?: string): Promise<{ matches: CliMatch[]; files: number }> {
  const root = resolve(input.cwd);
  const target = resolve(root, input.path?.trim() || ".");
  if (!isInside(root, target)) throw new Error("Path must be inside the project workspace");
  const language = cliLanguage(input);
  if (!language) {
    throw new Error("Specify lang for this language, for example go, rust, java, c, cpp, csharp, ruby, php, kotlin, swift, scala, bash, lua, elixir, haskell, sql, yaml or json.");
  }
  const pattern = String(input.pattern ?? "");
  if (!pattern.trim()) throw new Error("A pattern is required");
  const args = [
    "run",
    "-p",
    pattern,
    "-l",
    language,
    "--json=stream",
    "--color=never",
  ];
  if (rewrite !== undefined) args.push("-r", rewrite);
  args.push(target);
  const result = await runCli(args, root);
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matches: CliMatch[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const match = mapMatch(parsed, root);
      if (match) matches.push(match);
    } catch {
      /* ignore non-JSON output */
    }
  }
  if (!matches.length && result.code !== 0) {
    const stderr = cleanStderr(result.stderr);
    if (/error|invalid|failed|not found/i.test(stderr)) {
      throw new Error(stderr || `ast-grep CLI exited with code ${result.code}`);
    }
  }
  return { matches, files: new Set(matches.map((match) => match.path)).size };
}

export async function genericAstGrep(input: AstGrepInput): Promise<AstResult> {
  const { matches, files } = await cliMatches(input);
  const limit = Math.max(1, Math.min(1_000, Number(input.limit) || 100));
  const selected = matches.slice(0, limit);
  return {
    matches: selected.map(({ start: _start, end: _end, replacement: _replacement, ...match }) => match),
    files,
    truncated: matches.length > limit,
    errors: [],
  };
}

export async function genericAstEdit(input: AstEditInput): Promise<AstEditResult> {
  const root = resolve(input.cwd);
  const { matches, files } = await cliMatches(input, input.rewrite);
  const limit = Math.max(1, Math.min(1_000, Number(input.limit) || 100));
  const limited = matches.slice(0, limit);
  const truncated = matches.length > limit;
  const changes: AstMatch[] = [];
  const grouped = new Map<string, CliMatch[]>();
  for (const match of limited) {
    const group = grouped.get(match.path) ?? [];
    group.push(match);
    grouped.set(match.path, group);
  }
  for (const [path, group] of grouped) {
    const selected: CliMatch[] = [];
    let lastEnd = -1;
    for (const match of group.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (match.start < lastEnd) continue;
      selected.push(match);
      lastEnd = match.end;
    }
    if (!selected.length) continue;
    if (!input.dryRun) {
      const absolute = resolve(root, path);
      let buffer = readFileSync(absolute);
      for (const match of [...selected].sort((a, b) => b.start - a.start)) {
        buffer = Buffer.concat([
          buffer.subarray(0, match.start),
          Buffer.from(match.replacement, "utf8"),
          buffer.subarray(match.end),
        ]);
      }
      writeFileSync(absolute, buffer);
    }
    for (const match of selected) {
      changes.push({
        path: match.path,
        line: match.line,
        column: match.column,
        endLine: match.endLine,
        endColumn: match.endColumn,
        text: match.replacement,
        captures: match.captures,
      });
    }
  }
  return {
    changes,
    files,
    applied: input.dryRun !== true,
    truncated,
    errors: [],
  };
}
