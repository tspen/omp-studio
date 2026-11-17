import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { WorkspaceFile, WorkspaceMatch, WorkspaceSymbol } from "../../shared/types";
import type { Store } from "./store";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs", ".rb", ".php",
  ".swift", ".kt", ".c", ".h", ".cpp", ".hpp", ".vue", ".svelte", ".scala", ".lua",
]);
const IGNORED = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".turbo", "target", "vendor", ".venv", "venv", "__pycache__"]);
const MAX_SCAN_FILES = 4000;
const MAX_READ = 400_000;

export class WorkspaceService {
  private store: Store;
  private cache = new Map<string, { paths: string[]; at: number }>();

  constructor(store: Store) {
    this.store = store;
  }

  rootFor(input: { nodeId?: string; threadId?: string } = {}): string {
    const thread = input.threadId ? this.store.getThread(input.threadId) : undefined;
    const node = input.nodeId ? this.store.getNode(input.nodeId) : thread ? this.store.getNode(thread.nodeId) : undefined;
    if (!node) throw new Error("No project selected");
    const root = thread?.worktreePath || node.repoPath || node.path;
    if (!root) throw new Error("Project has no folder");
    return root;
  }

  listFiles(input: { nodeId?: string; threadId?: string; query?: string; limit?: number } = {}): WorkspaceFile[] {
    const root = this.rootFor(input);
    const query = (input.query ?? "").trim().toLowerCase();
    const limit = Math.min(400, Math.max(1, input.limit ?? 80));
    const paths = this.listPaths(root);
    const matched = query
      ? paths.filter((path) => path.toLowerCase().includes(query) || basename(path).toLowerCase().includes(query))
      : paths;
    const scored = matched.slice(0, 1200).map((path) => {
      const full = join(root, path);
      let size = 0;
      let modifiedAt = 0;
      try {
        const stat = statSync(full);
        size = stat.size;
        modifiedAt = stat.mtimeMs;
      } catch {
        /* ignore */
      }
      const name = basename(path);
      const score = (query && name.toLowerCase() === query ? 4 : 0) + (query && name.toLowerCase().startsWith(query) ? 2 : 0);
      return { path, name, dir: dirname(path) === "." ? "" : dirname(path), size, modifiedAt, score };
    });
    scored.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
    return scored.slice(0, limit).map(({ score, ...file }) => file);
  }

  searchSymbols(input: { nodeId?: string; threadId?: string; query?: string; limit?: number } = {}): WorkspaceSymbol[] {
    const root = this.rootFor(input);
    const query = (input.query ?? "").trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, input.limit ?? 60));
    const paths = this.listPaths(root).filter((path) => CODE_EXTENSIONS.has(extname(path).toLowerCase()));
    const ranked = paths.slice(0, 800);
    const results: WorkspaceSymbol[] = [];
    for (const path of ranked) {
      if (results.length >= limit * 4) break;
      let text = "";
      try {
        const full = join(root, path);
        if (statSync(full).size > MAX_READ) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const symbol of symbolsInFile(path, text)) {
        if (query && !symbol.name.toLowerCase().includes(query) && !symbol.path.toLowerCase().includes(query)) continue;
        results.push(symbol);
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    return results;
  }

  attachImage(input: { nodeId?: string; threadId?: string; name: string; dataUrl: string }): { path: string } {
    const match = /^data:([^;]+);base64,(.+)$/.exec(input.dataUrl);
    if (!match) throw new Error("Unsupported image data");
    const mime = match[1];
    const extension = mime.includes("jpeg") ? ".jpg" : mime.includes("gif") ? ".gif" : mime.includes("webp") ? ".webp" : ".png";
    const safe = (input.name || "image").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.[a-zA-Z0-9]+$/, "");
    const directory = join(this.store.baseDir, "artifacts", "attachments");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${Date.now()}-${safe || "image"}${extension}`);
    writeFileSync(path, Buffer.from(match[2], "base64"));
    return { path };
  }

  searchContent(input: { nodeId?: string; threadId?: string; query: string; limit?: number }): WorkspaceMatch[] {
    const root = this.rootFor(input);
    const query = input.query.trim().toLowerCase();
    if (query.length < 2) return [];
    const limit = Math.min(200, Math.max(1, input.limit ?? 60));
    const paths = this.listPaths(root).slice(0, 2500);
    const results: WorkspaceMatch[] = [];
    for (const path of paths) {
      if (results.length >= limit) break;
      if (!CODE_EXTENSIONS.has(extname(path).toLowerCase()) && !/\.(md|mdx|txt|json|ya?ml|toml|html|css|scss)$/i.test(path)) continue;
      let text = "";
      try {
        const full = join(root, path);
        if (statSync(full).size > MAX_READ) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (!text.toLowerCase().includes(query)) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(query)) continue;
        results.push({ path, line: index + 1, preview: lines[index].trim().slice(0, 220) });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  map(input: { nodeId?: string; threadId?: string; limit?: number } = {}): WorkspaceSymbol[] {
    return this.searchSymbols({ nodeId: input.nodeId, threadId: input.threadId, query: "", limit: Math.min(400, input.limit ?? 250) });
  }

  private listPaths(root: string): string[] {
    if (!existsSync(root)) return [];
    const cached = this.cache.get(root);
    if (cached && Date.now() - cached.at < 30_000) return cached.paths;
    const fromGit = this.gitFiles(root);
    if (fromGit.length) {
      this.cache.set(root, { paths: fromGit, at: Date.now() });
      return fromGit;
    }
    const result: string[] = [];
    const walk = (directory: string) => {
      if (result.length >= MAX_SCAN_FILES) return;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (result.length >= MAX_SCAN_FILES) return;
        if (entry.isDirectory()) {
          if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
          walk(join(directory, entry.name));
        } else if (entry.isFile()) {
          result.push(relative(root, join(directory, entry.name)).replace(/\\/g, "/"));
        }
      }
    };
    walk(root);
    const sorted = result.sort();
    this.cache.set(root, { paths: sorted, at: Date.now() });
    return sorted;
  }

  private gitFiles(root: string): string[] {
    try {
      const output = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 8_000 },
      ) as string;
      return output
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\\/g, "/"))
        .filter((line) => line && !line.split("/").some((part) => IGNORED.has(part)));
    } catch {
      return [];
    }
  }
}

function symbolsInFile(path: string, text: string): WorkspaceSymbol[] {
  const extension = extname(path).toLowerCase();
  const patterns: Array<{ regex: RegExp; kind: string }> = [];
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"].includes(extension)) {
    patterns.push({ regex: /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, kind: "function" });
    patterns.push({ regex: /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, kind: "class" });
    patterns.push({ regex: /(?:^|\n)\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, kind: "type" });
    patterns.push({ regex: /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g, kind: "function" });
  } else if (extension === ".py") {
    patterns.push({ regex: /(?:^|\n)\s*(?:async\s+)?def\s+(\w+)/g, kind: "function" });
    patterns.push({ regex: /(?:^|\n)\s*class\s+(\w+)/g, kind: "class" });
  } else if (extension === ".go") {
    patterns.push({ regex: /(?:^|\n)\s*func\s+(?:\([^)]*\)\s*)?(\w+)/g, kind: "function" });
    patterns.push({ regex: /(?:^|\n)\s*type\s+(\w+)/g, kind: "type" });
  } else if (extension === ".rs") {
    patterns.push({ regex: /(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g, kind: "function" });
    patterns.push({ regex: /(?:^|\n)\s*(?:pub\s+)?(?:struct|enum|trait|union)\s+(\w+)/g, kind: "type" });
  } else {
    patterns.push({ regex: /(?:^|\n)\s*(?:public|private|protected|internal|static|final|abstract|\s)*\s*(?:class|interface|enum|record|struct)\s+(\w+)/g, kind: "type" });
    patterns.push({ regex: /(?:^|\n)\s*(?:public|private|protected|internal|static|async|\s)+[\w<>\[\],.]+\s+(\w+)\s*\([^)]*\)\s*\{/g, kind: "function" });
  }
  const results: WorkspaceSymbol[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const name = match[1];
      if (!name || name.length > 80) continue;
      const index = match.index ?? 0;
      const line = text.slice(0, index).split(/\r?\n/).length;
      const preview = text.split(/\r?\n/)[line - 1]?.trim().slice(0, 160) ?? "";
      results.push({ name, kind: pattern.kind, path, line, preview });
    }
  }
  return results;
}
