import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineStatus } from "../../shared/types";
import type { Store } from "../services/store";

const PI_PACKAGE = join("node_modules", "@earendil-works", "pi-coding-agent");
const PI_CLI = join(PI_PACKAGE, "dist", "cli.js");

/**
 * Locates the bundled Pi coding agent. Pi is a Node package, so the engine
 * "binary" is its CLI entry point; PiSession runs it with the Electron binary
 * in ELECTRON_RUN_AS_NODE mode.
 */
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
    candidates.push({ path: join(app.getAppPath(), PI_CLI), source: "bundled" });
    candidates.push({ path: join(process.resourcesPath, "app.asar.unpacked", PI_CLI), source: "bundled" });
    candidates.push({ path: join(process.resourcesPath, "pi", "dist", "cli.js"), source: "bundled" });
    candidates.push({ path: join(this.store.baseDir, "engine", "pi", "dist", "cli.js"), source: "downloaded" });

    for (const candidate of candidates) {
      if (!candidate.path || !existsSync(candidate.path)) continue;
      try {
        const version = this.version(candidate.path);
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
      error: "Pi engine not found. Reinstall Perch or point Engine path at @earendil-works/pi-coding-agent/dist/cli.js.",
      checkedAt: Date.now(),
    };
    this.store.setEngine(this.status);
    return this.status;
  }

  private version(cliPath: string): string {
    const packagePath = join(cliPath, "..", "..", "package.json");
    if (!existsSync(packagePath)) return "unknown";
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
    return pkg.version || "unknown";
  }

  resolveForSpawn(): string {
    if (this.status.found && this.status.path) return this.status.path;
    const bundled = join(app.getAppPath(), PI_CLI);
    if (existsSync(bundled)) return bundled;
    const unpacked = join(process.resourcesPath, "app.asar.unpacked", PI_CLI);
    if (existsSync(unpacked)) return unpacked;
    const resource = join(process.resourcesPath, "pi", "dist", "cli.js");
    if (existsSync(resource)) return resource;
    throw new Error("Pi engine is not available");
  }

  async download(): Promise<EngineStatus> {
    // Pi ships with the app as a dependency. There is no remote binary to fetch.
    this.status = {
      found: existsSync(this.resolveForSpawn()),
      downloading: false,
      error: "Pi is bundled with Perch; reinstall the app to repair it.",
      checkedAt: Date.now(),
    };
    this.store.setEngine(this.status);
    this.onProgress?.(this.status);
    return this.status;
  }
}
