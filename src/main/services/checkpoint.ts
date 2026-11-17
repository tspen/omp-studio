import type { CheckpointInfo, CheckpointInput } from "../../shared/types";
import type { Store } from "./store";

/**
 * Client for the host-side checkpoint agent. The agent drives Docker's CRIU
 * checkpoint/restore API; this service only talks to its authenticated HTTP API.
 */
export class CheckpointService {
  private store: Store;
  private lastError: string | undefined;

  constructor(store: Store) {
    this.store = store;
  }

  private config(): { url: string; container: string; token: string } {
    const settings = this.store.settings.remoteCheckpoint ?? { url: "http://127.0.0.1:43160", container: "omp-runner" };
    return {
      url: (process.env.OMP_CHECKPOINT_URL || settings.url || "").replace(/\/+$/, ""),
      container: process.env.OMP_CHECKPOINT_CONTAINER || settings.container || "omp-runner",
      token: process.env.OMP_CHECKPOINT_TOKEN || this.store.getSecret("remote.checkpoint.token") || "",
    };
  }

  async info(): Promise<CheckpointInfo> {
    const config = this.config();
    const base: CheckpointInfo = {
      configured: !!(config.url && config.container && config.token),
      running: false,
      url: config.url,
      container: config.container,
      checkpoints: [],
      bundles: [],
      error: this.lastError,
    };
    if (!base.configured) return base;
    try {
      const health = await this.request("/health", "GET", undefined, false);
      base.running = !!health?.ok;
      const list = await this.request(`/checkpoints?container=${encodeURIComponent(config.container)}`, "GET");
      base.checkpoints = Array.isArray(list) ? list.map((item: { Name?: string }) => String(item.Name ?? "")).filter(Boolean) : [];
      const bundles = await this.request("/bundles", "GET");
      base.bundles = Array.isArray(bundles) ? bundles.map((item: { name?: string; path?: string }) => ({ name: String(item.name ?? ""), path: String(item.path ?? "") })) : [];
      this.lastError = undefined;
    } catch (error) {
      base.running = false;
      base.error = error instanceof Error ? error.message : String(error);
    }
    return base;
  }

  async configure(input: CheckpointInput): Promise<CheckpointInfo> {
    if (input.token.trim()) this.store.setSecret("remote.checkpoint.token", input.token.trim());
    this.store.setSettings({
      remoteCheckpoint: {
        url: (input.url || "http://127.0.0.1:43160").trim().replace(/\/+$/, ""),
        container: input.container.trim() || "omp-runner",
      },
    });
    this.lastError = undefined;
    return this.info();
  }

  async create(name?: string): Promise<CheckpointInfo> {
    const checkpoint = name?.trim() || `omp-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await this.request("/checkpoint", "POST", { container: this.config().container, name: checkpoint });
    return this.info();
  }

  async restore(name: string): Promise<CheckpointInfo> {
    await this.request("/restore", "POST", { container: this.config().container, name });
    return this.info();
  }

  async exportBundle(name?: string): Promise<{ bundle: string; bytes: number }> {
    const checkpoint = name?.trim() || `omp-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const result = await this.request("/export", "POST", { container: this.config().container, name: checkpoint });
    return { bundle: String(result.bundle ?? ""), bytes: Number(result.bytes ?? 0) };
  }

  async importBundle(bundle: string, name?: string): Promise<{ container: string; id: string }> {
    const result = await this.request("/import", "POST", { bundle, name });
    return { container: String(result.container ?? ""), id: String(result.id ?? "") };
  }

  async remove(name: string): Promise<CheckpointInfo> {
    await this.request("/checkpoint", "DELETE", { container: this.config().container, name });
    return this.info();
  }

  private async request(path: string, method: string, body?: unknown, authorize = true): Promise<any> {
    const config = this.config();
    const response = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        ...(authorize ? { authorization: `Bearer ${config.token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(payload?.error || `Checkpoint agent HTTP ${response.status}`);
    return payload;
  }
}

