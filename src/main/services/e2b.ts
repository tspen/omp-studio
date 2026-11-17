import { randomBytes } from "node:crypto";
import { E2B, Sandbox } from "e2b";
import type { E2BInfo, E2BInput, RemoteTarget } from "../../shared/types";
import type { RemoteService } from "./remote";
import type { Store } from "./store";

/**
 * E2B Embed target adapter.
 *
 * Sandboxes are created from a template that runs the OMP runner on port 43120.
 * The runner URL is the sandbox's exposed port; the per-sandbox token is passed
 * as OMP_REMOTE_TOKEN. The sandbox is terminated when its target is removed.
 */
export class E2BService {
  private store: Store;
  private remote: RemoteService;
  private lastError: string | undefined;

  constructor(store: Store, remote: RemoteService) {
    this.store = store;
    this.remote = remote;
  }

  private config(): { apiUrl: string; domain: string; template: string; timeoutMinutes: number; apiKey: string } {
    const settings = this.store.settings.remoteE2B ?? { apiUrl: "http://127.0.0.1:3000", domain: "localhost", template: "omp-runner", timeoutMinutes: 60 };
    return {
      apiUrl: process.env.E2B_API_URL || settings.apiUrl || "http://127.0.0.1:3000",
      domain: process.env.E2B_DOMAIN || settings.domain || "localhost",
      template: process.env.E2B_TEMPLATE || settings.template || "omp-runner",
      timeoutMinutes: Number(process.env.E2B_TIMEOUT_MINUTES || settings.timeoutMinutes || 60),
      apiKey: process.env.E2B_API_KEY || this.store.getSecret("remote.e2b.key") || "",
    };
  }

  async info(): Promise<E2BInfo> {
    const config = this.config();
    return {
      configured: !!(config.apiUrl && config.template && config.apiKey),
      apiUrl: config.apiUrl,
      domain: config.domain,
      template: config.template,
      hasKey: !!config.apiKey,
      targets: this.remote.listTargets().filter((target) => target.kind === "e2b-embed"),
      error: this.lastError,
    };
  }

  async configure(input: E2BInput): Promise<E2BInfo> {
    const apiUrl = (input.apiUrl || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
    const domain = input.domain.trim() || "localhost";
    const template = input.template.trim() || "omp-runner";
    if (input.apiKey.trim()) this.store.setSecret("remote.e2b.key", input.apiKey.trim());
    this.store.setSettings({ remoteE2B: { apiUrl, domain, template, timeoutMinutes: Math.max(5, Number(input.timeoutMinutes) || 60) } });
    this.lastError = undefined;
    return this.info();
  }

  async provision(): Promise<RemoteTarget> {
    const config = this.config();
    if (!config.apiKey) throw new Error("An E2B API key is required");
    if (!config.template) throw new Error("An E2B template is required");
    this.lastError = undefined;
    const token = randomBytes(24).toString("hex");
    let sandbox: Sandbox | null = null;
    try {
      sandbox = await Sandbox.create(config.template, {
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        domain: config.domain,
        timeoutMs: Math.max(10, config.timeoutMinutes) * 60_000,
        metadata: { omp: "studio", role: "runner" },
        envs: {
          OMP_REMOTE_TOKEN: token,
          OMP_REMOTE_HOST: "0.0.0.0",
          OMP_REMOTE_PORT: "43120",
          OMP_STUDIO_USER_DATA: "/data",
          OMP_HEADLESS: "1",
        },
      });
      const host = sandbox.getHost(43120);
      const candidates = /^https?:\/\//.test(host)
        ? [host]
        : [`http://${host}`, `https://${host}`];
      let url = "";
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          await waitHealthy(candidate, token, 90_000);
          url = candidate;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!url) throw new Error(`E2B runner did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
      const targets = await this.remote.addTarget({
        name: `E2B ${sandbox.sandboxId.slice(0, 8)}`,
        url,
        token,
        kind: "e2b-embed",
        sandboxId: sandbox.sandboxId,
        template: config.template,
      });
      return targets.find((target) => target.sandboxId === sandbox!.sandboxId) ?? targets[0];
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      if (sandbox) await sandbox.kill().catch(() => undefined);
      throw error;
    }
  }

  async terminate(targetId: string): Promise<E2BInfo> {
    const target = this.remote.listTargets().find((item) => item.id === targetId);
    const config = this.config();
    if (target?.sandboxId && config.apiKey) {
      const client = new E2B({ apiKey: config.apiKey, apiUrl: config.apiUrl, domain: config.domain });
      await client.Sandbox.kill(target.sandboxId).catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }
    this.remote.removeTarget(targetId);
    return this.info();
  }
}

async function waitHealthy(url: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw lastError instanceof Error ? lastError : new Error("timed out");
}

