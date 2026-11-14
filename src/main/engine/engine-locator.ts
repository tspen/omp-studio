import { app } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { EngineStatus } from "../../shared/types";
import type { Store } from "../services/store";

const RELEASE_API = "https://api.github.com/repos/can1357/oh-my-pi/releases/latest";
const FALLBACK_ASSET =
  "https://github.com/can1357/oh-my-pi/releases/download/v18.20.0/omp-windows-x64.exe";

export class EngineLocator {
  private store: Store;
  private status: EngineStatus = { found: false, downloading: false, checkedAt: 0 };
  private onProgress?: (status: EngineStatus) => void;

  constructor(store: Store) {
    this.store = store;
  }

  setProgressHandler(handler: (status: EngineStatus) => void): void {
    this.onProgress = handler;
  }

  get current(): EngineStatus {
    return this.status;
  }

  async detect(): Promise<EngineStatus> {
    const candidates: Array<{ path: string; source: EngineStatus["source"] }> = [];
    if (this.store.settings.enginePath) {
      candidates.push({ path: this.store.settings.enginePath, source: "custom" });
    }
    candidates.push({ path: join(process.resourcesPath, "omp", "omp.exe"), source: "bundled" });
    candidates.push({ path: join(app.getAppPath(), "vendor", "omp", "omp.exe"), source: "bundled" });
    candidates.push({ path: join(this.store.baseDir, "engine", "omp.exe"), source: "downloaded" });
    const local = process.env.LOCALAPPDATA;
    if (local) candidates.push({ path: join(local, "omp", "omp.exe"), source: "installed" });
    const onPath = findOnPath("omp.exe");
    if (onPath) candidates.push({ path: onPath, source: "installed" });

    for (const candidate of candidates) {
      if (!candidate.path || !existsSync(candidate.path)) continue;
      try {
        const version = await this.version(candidate.path);
        this.status = {
          found: true,
          path: candidate.path,
          version,
          source: candidate.source,
          downloading: false,
          checkedAt: Date.now(),
        };
        this.store.setEngine(this.status);
        return this.status;
      } catch {
        /* try next */
      }
    }

    this.status = {
      found: false,
      downloading: false,
      error: "OMP engine not found. Download it from Settings or install it with the OMP installer.",
      checkedAt: Date.now(),
    };
    this.store.setEngine(this.status);
    return this.status;
  }

  private version(exe: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(exe, ["--version"], { timeout: 20_000, windowsHide: true }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const value = stdout.trim().replace(/^omp\//, "");
        resolve(value || "unknown");
      });
    });
  }

  resolveForSpawn(): string {
    if (this.status.found && this.status.path) return this.status.path;
    const fallback = this.status.path ?? join(this.store.baseDir, "engine", "omp.exe");
    if (existsSync(fallback)) return fallback;
    const bundled = join(process.resourcesPath, "omp", "omp.exe");
    if (existsSync(bundled)) return bundled;
    const dev = join(app.getAppPath(), "vendor", "omp", "omp.exe");
    if (existsSync(dev)) return dev;
    throw new Error("OMP engine is not available");
  }

  async download(): Promise<EngineStatus> {
    if (this.status.downloading) return this.status;
    const targetDir = join(this.store.baseDir, "engine");
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, "omp.exe");
    const partial = `${target}.part`;
    this.setDownloading(true, 0);
    try {
      const assetUrl = await this.latestWindowsAsset();
      const response = await fetch(assetUrl, {
        headers: { "User-Agent": "OMP-Studio" },
        redirect: "follow",
      });
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      const total = Number(response.headers.get("content-length") || 0);
      let received = 0;
      const source = Readable.fromWeb(response.body as any);
      source.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0) this.setDownloading(true, Math.min(99, Math.round((received / total) * 100)));
      });
      await pipeline(source, createWriteStream(partial));
      if (existsSync(target)) unlinkSync(target);
      const { renameSync } = await import("node:fs");
      renameSync(partial, target);
      const size = statSync(target).size;
      if (size < 50 * 1024 * 1024) throw new Error("Downloaded engine looks incomplete");
      const version = await this.version(target);
      this.status = {
        found: true,
        path: target,
        version,
        source: "downloaded",
        downloading: false,
        progress: 100,
        checkedAt: Date.now(),
      };
      this.store.setEngine(this.status);
      this.onProgress?.(this.status);
      return this.status;
    } catch (error) {
      try {
        if (existsSync(partial)) unlinkSync(partial);
      } catch {
        /* ignore */
      }
      this.status = {
        found: false,
        downloading: false,
        error: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now(),
      };
      this.store.setEngine(this.status);
      this.onProgress?.(this.status);
      return this.status;
    }
  }

  private setDownloading(downloading: boolean, progress?: number): void {
    this.status = { ...this.status, downloading, progress, error: undefined };
    this.onProgress?.(this.status);
  }

  private async latestWindowsAsset(): Promise<string> {
    try {
      const response = await fetch(RELEASE_API, {
        headers: { "User-Agent": "OMP-Studio", Accept: "application/vnd.github+json" },
      });
      if (response.ok) {
        const json = (await response.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
        const asset = json.assets?.find((item) => item.name === "omp-windows-x64.exe");
        if (asset?.browser_download_url) return asset.browser_download_url;
      }
    } catch {
      /* fall back */
    }
    return FALLBACK_ASSET;
  }
}

function findOnPath(command: string): string | undefined {
  try {
    const output = execFileSync("where.exe", [command], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first || undefined;
  } catch {
    return undefined;
  }
}
