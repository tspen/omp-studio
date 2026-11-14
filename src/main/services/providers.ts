import { spawn } from "node:child_process";
import providersData from "../data/providers.json";
import type { ProviderInfo } from "../../shared/types";
import { providerBilling } from "./billing";
import type { EngineLocator } from "../engine/engine-locator";
import type { ModelService } from "./models";
import type { Store } from "./store";

interface RawProvider {
  id: string;
  name: string;
  login: string;
  authUrl?: string;
  instructions?: string;
  prompt?: string;
  envVar?: string;
  recommended?: boolean;
}

const RAW_PROVIDERS = providersData as RawProvider[];

export class ProviderService {
  private store: Store;
  private engine: EngineLocator;
  private models: ModelService;

  constructor(store: Store, engine: EngineLocator, models: ModelService) {
    this.store = store;
    this.engine = engine;
    this.models = models;
  }

  list(): ProviderInfo[] {
    const counts = new Map<string, number>();
    for (const model of this.store.data.models) {
      if (model.available) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    }
    return RAW_PROVIDERS.map((provider) => ({
      id: provider.id,
      name: provider.name,
      login: provider.login,
      authUrl: provider.authUrl,
      instructions: provider.instructions,
      prompt: provider.prompt,
      envVar: provider.envVar,
      recommended: !!provider.recommended,
      connected: (counts.get(provider.id) ?? 0) > 0,
      modelCount: counts.get(provider.id) ?? 0,
      billing: providerBilling(provider.id),
    })).sort((a, b) => providerRank(a) - providerRank(b) || a.name.localeCompare(b.name));
  }

  async connect(id: string, apiKey?: string): Promise<{ ok: boolean; output: string; providers: ProviderInfo[] }> {
    const provider = RAW_PROVIDERS.find((item) => item.id === id);
    if (!provider) throw new Error(`Unknown OMP provider: ${id}`);
    if (provider.login === "none") {
      return {
        ok: false,
        output: `${provider.name} does not use an interactive login. Configure it through OMP settings or its local endpoint.`,
        providers: this.list(),
      };
    }
    if (provider.login === "api-key" && !apiKey?.trim()) {
      return { ok: false, output: `${provider.name} requires an API key.`, providers: this.list() };
    }
    if (provider.id === "opencode-go" && apiKey?.trim()) {
      const validation = await validateOpenCodeGo(apiKey.trim());
      if (!validation.ok) {
        return { ok: false, output: validation.error ?? "OpenCode Go rejected that API key.", providers: this.list() };
      }
    }

    const exe = this.engine.resolveForSpawn();
    const args = ["login", provider.id];
    const child = spawn(exe, args, {
      cwd: this.store.baseDir,
      env: { ...process.env, PI_NO_TITLE: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let keySent = false;
    const clean = (text: string) => stripAnsi(text).replaceAll(apiKey ?? "__never__", "••••••••");
    const onData = (data: Buffer) => {
      const text = data.toString();
      output += text;
      if (!keySent && apiKey && /paste|api key|key\b|prompt/i.test(stripAnsi(text))) {
        keySent = true;
        try { child.stdin.write(`${apiKey.trim()}\n`); } catch { /* login already closed */ }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });

    if (apiKey) {
      // Some login flows print the prompt without a word we can reliably match.
      setTimeout(() => {
        if (!keySent && !child.killed) {
          keySent = true;
          try { child.stdin.write(`${apiKey.trim()}\n`); } catch { /* login already closed */ }
        }
      }, 1200);
    }

    const timeoutMs = provider.login === "api-key" ? 120_000 : 300_000;
    const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve({ ok: false, output: `${clean(output)}\n\nTimed out waiting for ${provider.name}.` });
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, output: clean(output).trim() || (code === 0 ? "Connected." : "Login failed.") });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, output: clean(error.message) });
      });
    });

    if (result.ok) {
      this.store.setSettings({ models: { ...this.store.settings.models, preferredProvider: provider.id } });
      try {
        await this.models.refresh();
        await this.models.refreshAA();
        this.models.resetDefaults();
      } catch {
        /* models can be refreshed later */
      }
    }
    return { ...result, providers: this.list() };
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

async function validateOpenCodeGo(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("https://opencode.ai/inference/go/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}`, "user-agent": "OMP-Studio" },
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: `OpenCode Go rejected that API key (HTTP ${response.status}).` };
    }
    return { ok: false, error: `OpenCode Go validation failed (HTTP ${response.status}).` };
  } catch (error) {
    return { ok: false, error: `Could not reach OpenCode Go to validate the key: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function providerRank(provider: ProviderInfo): number {
  if (provider.id === "opencode-go") return 0;
  if (provider.connected) return 1;
  if (provider.recommended) return 2;
  return 3;
}
