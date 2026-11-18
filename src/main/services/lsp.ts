import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface LspServer {
  process: ChildProcessWithoutNullStreams;
  root: string;
  pending: Map<number, Pending>;
  diagnostics: Map<string, any[]>;
  opened: Map<string, number>;
  version: number;
  buffer: Buffer;
  initialized: Promise<void>;
}

const servers = new Map<string, LspServer>();
let sequence = 0;

function cliPath(): string {
  const relativePath = ["node_modules", "typescript-language-server", "lib", "cli.mjs"];
  const resources = (process as any).resourcesPath as string | undefined;
  const candidates = [
    resources ? join(resources, "app.asar.unpacked", ...relativePath) : "",
    resources ? join(resources, "app.asar", ...relativePath) : "",
    resolve(...relativePath),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1];
}

function languageId(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".ts": return "typescript";
    case ".tsx": return "typescriptreact";
    case ".js": return "javascript";
    case ".jsx": return "javascriptreact";
    case ".json": return "json";
    default: return "plaintext";
  }
}

function send(server: LspServer, message: any): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  server.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  server.process.stdin.write(body);
}

function request(server: LspServer, method: string, params: any, timeoutMs = 20_000): Promise<any> {
  const id = ++sequence;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      server.pending.delete(id);
      rejectPromise(new Error(`LSP ${method} timed out`));
    }, timeoutMs);
    server.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    send(server, { jsonrpc: "2.0", id, method, params });
  });
}

function notify(server: LspServer, method: string, params: any): void {
  send(server, { jsonrpc: "2.0", method, params });
}

function start(root: string): LspServer {
  const existing = servers.get(root);
  if (existing && existing.process.exitCode === null) return existing;
  const child = spawn(process.execPath, [cliPath(), "--stdio"], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const server: LspServer = {
    process: child,
    root,
    pending: new Map(),
    diagnostics: new Map(),
    opened: new Map(),
    version: 0,
    buffer: Buffer.alloc(0),
    initialized: Promise.resolve(),
  };
  servers.set(root, server);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => undefined);
  child.stdout.on("data", (chunk: Buffer) => {
    server.buffer = Buffer.concat([server.buffer, chunk]);
    for (;;) {
      const headerEnd = server.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = server.buffer.subarray(0, headerEnd).toString("utf8");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
      if (!length) {
        server.buffer = server.buffer.subarray(headerEnd + 4);
        continue;
      }
      if (server.buffer.length < headerEnd + 4 + length) break;
      const body = server.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      server.buffer = server.buffer.subarray(headerEnd + 4 + length);
      let message: any;
      try { message = JSON.parse(body); } catch { continue; }
      if (message.id && server.pending.has(message.id)) {
        const pending = server.pending.get(message.id)!;
        clearTimeout(pending.timer);
        server.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "LSP request failed"));
        else pending.resolve(message.result);
      } else if (message.method === "textDocument/publishDiagnostics") {
        server.diagnostics.set(message.params.uri, message.params.diagnostics ?? []);
      }
    }
  });
  child.on("exit", () => {
    servers.delete(root);
    for (const pending of server.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("LSP server exited"));
    }
    server.pending.clear();
  });
  const rootUri = pathToFileURL(root).href;
  server.initialized = request(server, "initialize", {
    processId: child.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    capabilities: {
      workspace: { workspaceFolders: true },
      textDocument: {
        definition: {},
        references: {},
        hover: { contentFormat: ["markdown", "plaintext"] },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        publishDiagnostics: {},
      },
    },
  }, 30_000).then(() => {
    notify(server, "initialized", {});
  });
  return server;
}

async function open(server: LspServer, file: string): Promise<string> {
  const uri = pathToFileURL(file).href;
  const text = readFileSync(file, "utf8");
  const version = (server.opened.get(uri) ?? 0) + 1;
  server.opened.set(uri, version);
  if (version === 1) {
    notify(server, "textDocument/didOpen", {
      textDocument: { uri, languageId: languageId(file), version, text },
    });
  } else {
    notify(server, "textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }
  return uri;
}

function location(server: LspServer, item: any): any {
  const uri = item.uri ?? item.targetUri ?? "";
  const range = item.range ?? item.targetSelectionRange ?? item.targetRange ?? {};
  const file = uri.startsWith("file:") ? decodeURIComponent(new URL(uri).pathname).replace(/^\//, "").replaceAll("/", "\\") : uri;
  const path = file ? (isAbsolute(file) ? relative(server.root, file) : file) : "";
  return { path, range: { start: range.start, end: range.end } };
}

export async function lspRequest(input: {
  action: "diagnostics" | "definition" | "references" | "hover" | "symbols";
  cwd: string;
  path: string;
  line?: number;
  character?: number;
}): Promise<any> {
  const root = resolve(input.cwd);
  const file = isAbsolute(input.path) ? input.path : resolve(root, input.path);
  if (!existsSync(file)) throw new Error(`File not found: ${input.path}`);
  if (!existsSync(cliPath())) throw new Error("TypeScript language server is not installed");
  const server = start(root);
  await server.initialized;
  const uri = await open(server, file);
  const position = {
    line: Math.max(0, Number(input.line ?? 1) - 1),
    character: Math.max(0, Number(input.character ?? 1) - 1),
  };
  const document = { uri };
  if (input.action === "diagnostics") {
    const deadline = Date.now() + 8_000;
    while (!server.diagnostics.has(uri) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
    return (server.diagnostics.get(uri) ?? []).map((item: any) => ({
      message: item.message,
      severity: item.severity,
      source: item.source,
      range: item.range,
    })).slice(0, 200);
  }
  if (input.action === "definition") {
    const result = await request(server, "textDocument/definition", { textDocument: document, position });
    const items = Array.isArray(result) ? result : result ? [result] : [];
    return items.map((item) => location(server, item)).slice(0, 50);
  }
  if (input.action === "references") {
    const result = await request(server, "textDocument/references", { textDocument: document, position, context: { includeDeclaration: true } });
    return (Array.isArray(result) ? result : []).map((item) => location(server, item)).slice(0, 200);
  }
  if (input.action === "hover") {
    const result = await request(server, "textDocument/hover", { textDocument: document, position });
    const contents = result?.contents;
    if (typeof contents === "string") return { contents };
    if (Array.isArray(contents)) return { contents: contents.map((item: any) => item.value ?? String(item)).join("\n") };
    return { contents: contents?.value ?? "" };
  }
  const result = await request(server, "textDocument/documentSymbol", { textDocument: document });
  const flatten = (items: any[], depth = 0): any[] => {
    const out: any[] = [];
    for (const item of items ?? []) {
      out.push({ name: item.name, kind: item.kind, depth, range: item.range ?? item.location?.range });
      if (Array.isArray(item.children)) out.push(...flatten(item.children, depth + 1));
    }
    return out;
  };
  return flatten(Array.isArray(result) ? result : []).slice(0, 300);
}

export function disposeLsp(): void {
  for (const server of servers.values()) {
    try { server.process.kill("SIGTERM"); } catch { /* ignore */ }
  }
  servers.clear();
}



