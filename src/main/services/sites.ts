import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, isAbsolute, join, normalize, resolve } from "node:path";
import type { Site, SiteVersion } from "../../shared/types";
import type { Store } from "./store";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export class SiteService {
  private store: Store;
  private root: string;
  private server: Server | null = null;
  private port = 0;

  constructor(store: Store) {
    this.store = store;
    this.root = join(store.baseDir, "sites");
  }

  list(): Site[] {
    return this.store.sites;
  }

  async start(): Promise<number> {
    if (this.server && this.port) {
      this.updateUrls();
      return this.port;
    }
    this.port = await this.findPort(4338);
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolvePromise, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => resolvePromise());
    });
    this.updateUrls();
    return this.port;
  }

  create(input: { name: string; nodeId: string; path: string }): Site {
    const node = this.store.getNode(input.nodeId);
    if (!node) throw new Error("Project not found");
    const sourcePath = isAbsolute(input.path) ? normalize(input.path) : resolve(node.path, input.path);
    const now = Date.now();
    const site: Site = {
      id: `site_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      name: input.name.trim() || node.name,
      nodeId: node.id,
      sourcePath,
      url: "",
      versions: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.store.addSite(site);
  }

  async publish(id: string): Promise<Site> {
    const site = this.store.sites.find((item) => item.id === id);
    if (!site) throw new Error("Site not found");
    if (!existsSync(site.sourcePath) || !statSync(site.sourcePath).isDirectory()) {
      throw new Error(`Site source is not a directory: ${site.sourcePath}`);
    }
    await this.start();
    const versionId = `v${Date.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 5)}`;
    const destination = join(this.root, site.id, versionId);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    const stats = { files: 0, bytes: 0 };
    copyTree(site.sourcePath, destination, stats);
    const version: SiteVersion = { id: versionId, createdAt: Date.now(), files: stats.files, bytes: stats.bytes };
    const versions = [version, ...site.versions].slice(0, 12);
    this.pruneVersions(site.id, versions);
    return this.store.updateSite(site.id, {
      versions,
      currentVersion: versionId,
      url: `http://127.0.0.1:${this.port}/s/${site.id}/`,
    });
  }

  remove(id: string): void {
    this.store.removeSite(id);
    rmSync(join(this.root, id), { recursive: true, force: true });
  }

  setAccess(id: string, enabled: boolean): Site {
    const site = this.store.sites.find((item) => item.id === id);
    if (!site) throw new Error("Site not found");
    return this.store.updateSite(id, { accessToken: enabled ? randomUUID().replace(/-/g, "").slice(0, 24) : undefined });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolvePromise) => this.server!.close(() => resolvePromise()));
    this.server = null;
    this.port = 0;
  }

  private updateUrls(): void {
    if (!this.port) return;
    for (const site of this.store.sites) {
      const url = `http://127.0.0.1:${this.port}/s/${site.id}/`;
      if (site.url !== url) this.store.updateSite(site.id, { url });
    }
  }

  private pruneVersions(siteId: string, versions: SiteVersion[]): void {
    const keep = new Set(versions.map((version) => version.id));
    const directory = join(this.root, siteId);
    try {
      for (const name of readdirSync(directory)) {
        if (!keep.has(name)) rmSync(join(directory, name), { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }

  private handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/s\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) {
      res.writeHead(404).end("Not found");
      return;
    }
    const site = this.store.sites.find((item) => item.id === match[1]);
    if (!site) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (site.accessToken) {
      const cookieName = `omp_site_${site.id}`;
      const cookies = Object.fromEntries(
        (req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).filter((pair) => pair.length === 2),
      );
      const provided = url.searchParams.get("t");
      if (provided === site.accessToken) {
        res.setHeader("set-cookie", `${cookieName}=${site.accessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      } else if (cookies[cookieName] !== site.accessToken) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("This site is protected. Open the shared link that includes its access token.");
        return;
      }
    }
    if (!site.currentVersion) {
      res.writeHead(404).end("Site has no published version");
      return;
    }
    const base = join(this.root, site.id, site.currentVersion);
    const requested = decodeURIComponent(match[2] || "index.html");
    let file = normalize(join(base, requested));
    if (!file.startsWith(normalize(base))) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
    } catch {
      res.writeHead(404).end("Not found");
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  }

  private async findPort(preferred: number): Promise<number> {
    for (let port = preferred; port < preferred + 30; port += 1) {
      if (await isPortFree(port)) return port;
    }
    throw new Error("No free port for local sites");
  }
}

function copyTree(source: string, destination: string, stats: { files: number; bytes: number }): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, stats);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      stats.files += 1;
      try {
        stats.bytes += statSync(from).size;
      } catch {
        /* ignore */
      }
    }
  }
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => server.close(() => resolvePromise(true)));
    server.listen(port, "127.0.0.1");
  });
}
