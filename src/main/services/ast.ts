import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { genericAstEdit, genericAstGrep, wantsCli } from "./ast-cli";
import { pythonAstEdit, pythonAstGrep } from "./python-ast";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "venv",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".tsx": "Tsx",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".jsx": "Tsx",
  ".html": "Html",
  ".htm": "Html",
  ".css": "Css",
};

const LANGUAGE_VALUES: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "Tsx",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "Tsx",
  html: "Html",
  css: "Css",
};

export interface AstMatch {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
  captures: Record<string, string | string[]>;
}

export interface AstGrepInput {
  cwd: string;
  pattern: string;
  path?: string;
  lang?: string;
  limit?: number;
}

export interface AstEditInput extends AstGrepInput {
  rewrite: string;
  dryRun?: boolean;
}

export interface AstResult {
  matches: AstMatch[];
  files: number;
  truncated: boolean;
  errors: Array<{ path: string; message: string }>;
}

export interface AstEditResult {
  changes: AstMatch[];
  files: number;
  applied: boolean;
  truncated: boolean;
  errors: Array<{ path: string; message: string }>;
}

function languageFor(file: string, requested?: string): string | null {
  if (requested?.trim()) return LANGUAGE_VALUES[requested.trim().toLowerCase()] ?? null;
  return LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()] ?? null;
}

function wantsPython(input: { lang?: string; path?: string }): boolean {
  const language = (input.lang || "").trim().toLowerCase();
  if (language === "python" || language === "py") return true;
  return (input.path || "").trim().toLowerCase().endsWith(".py");
}

function isInside(root: string, target: string): boolean {
  const base = resolve(root);
  const path = resolve(target);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

function listFiles(root: string, target?: string): string[] {
  const start = resolve(root, target?.trim() || ".");
  if (!isInside(root, start)) throw new Error("Path must be inside the project workspace");
  let stat;
  try {
    stat = statSync(start);
  } catch {
    throw new Error(`Path not found: ${target ?? "."}`);
  }
  if (stat.isFile()) return [start];
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  walk(start);
  return files.sort();
}

function captureNames(pattern: string): Array<{ name: string; multiple: boolean }> {
  const names = new Map<string, boolean>();
  for (const match of pattern.matchAll(/\$(\${0,2})([A-Z_][A-Z0-9_]*)/g)) {
    const name = match[2];
    const multiple = match[1].length > 0;
    names.set(name, (names.get(name) ?? false) || multiple);
  }
  return [...names].map(([name, multiple]) => ({ name, multiple }));
}

function captureValues(node: any, pattern: string): Record<string, string | string[]> {
  const captures: Record<string, string | string[]> = {};
  for (const { name, multiple } of captureNames(pattern)) {
    if (multiple) {
      captures[name] = node.getMultipleMatches(name).map((child: any) => child.text());
    } else {
      const child = node.getMatch(name);
      if (child) captures[name] = child.text();
    }
  }
  return captures;
}

function renderRewrite(node: any, rewrite: string): string {
  return rewrite.replace(/\$(\${0,2})([A-Z_][A-Z0-9_]*)/g, (_match: string, dollars: string, name: string) => {
    if (dollars.length > 0) {
      return node.getMultipleMatches(name).map((child: any) => child.text()).join("");
    }
    return node.getMatch(name)?.text() ?? "";
  });
}

function matchDetails(root: string, file: string, node: any, pattern: string): AstMatch {
  const range = node.range();
  return {
    path: relative(root, file).split(sep).join("/"),
    line: range.start.line + 1,
    column: range.start.column + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.column + 1,
    text: node.text(),
    captures: captureValues(node, pattern),
  };
}

export async function astGrep(input: AstGrepInput): Promise<AstResult> {
  if (wantsPython(input)) return pythonAstGrep(input);
  if (wantsCli(input)) return genericAstGrep(input);
  const pattern = String(input.pattern ?? "");
  if (!pattern.trim()) throw new Error("ast_grep needs a pattern");
  const root = resolve(input.cwd);
  const files = listFiles(root, input.path);
  const limit = Math.max(1, Math.min(1_000, Number(input.limit) || 100));
  const matches: AstMatch[] = [];
  const errors: AstResult["errors"] = [];
  let parsedFiles = 0;
  let truncated = false;
  for (const file of files) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    const language = languageFor(file, input.lang);
    if (!language) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      errors.push({ path: relative(root, file), message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    try {
      const tree = parse(language as any, source).root();
      parsedFiles += 1;
      for (const node of tree.findAll({ rule: { pattern } })) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push(matchDetails(root, file, node, pattern));
      }
    } catch (error) {
      errors.push({ path: relative(root, file), message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { matches, files: parsedFiles, truncated, errors };
}

export async function astEdit(input: AstEditInput): Promise<AstEditResult> {
  if (wantsPython(input)) return pythonAstEdit(input);
  if (wantsCli(input)) return genericAstEdit(input);
  const pattern = String(input.pattern ?? "");
  const rewrite = String(input.rewrite ?? "");
  if (!pattern.trim()) throw new Error("ast_edit needs a pattern");
  if (!rewrite.trim()) throw new Error("ast_edit needs a rewrite");
  const root = resolve(input.cwd);
  const files = listFiles(root, input.path);
  const limit = Math.max(1, Math.min(1_000, Number(input.limit) || 100));
  const changes: AstMatch[] = [];
  const errors: AstEditResult["errors"] = [];
  let parsedFiles = 0;
  let truncated = false;
  const dryRun = input.dryRun === true;
  for (const file of files) {
    if (changes.length >= limit) {
      truncated = true;
      break;
    }
    const language = languageFor(file, input.lang);
    if (!language) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      errors.push({ path: relative(root, file), message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    try {
      const tree = parse(language as any, source).root();
      parsedFiles += 1;
      const nodes = tree.findAll({ rule: { pattern } });
      const edits: any[] = [];
      for (const node of nodes) {
        if (changes.length >= limit) {
          truncated = true;
          break;
        }
        const after = renderRewrite(node, rewrite);
        edits.push(node.replace(after));
        changes.push({ ...matchDetails(root, file, node, pattern), text: after });
      }
      if (!edits.length) continue;
      const updated = tree.commitEdits(edits);
      if (!dryRun && updated !== source) writeFileSync(file, updated, "utf8");
    } catch (error) {
      errors.push({ path: relative(root, file), message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { changes, files: parsedFiles, applied: !dryRun, truncated, errors };
}
