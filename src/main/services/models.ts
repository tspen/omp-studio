import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AAScore, ModelInfo } from "../../shared/types";
import type { EngineLocator } from "../engine/engine-locator";
import type { Store } from "./store";
import { providerBilling } from "./billing";

interface RawAAModel {
  slug: string;
  name: string;
  shortName?: string;
  release?: { slug?: string };
  deprecated?: boolean;
  isReasoning?: boolean;
  contextWindowTokens?: number;
  intelligenceIndex?: number | null;
  price1mInputTokens?: number | null;
  price1mOutputTokens?: number | null;
  outputSpeed?: number | null;
  scores?: Record<string, number | null>;
}

interface AACache {
  fetchedAt: number;
  source: string;
  models: RawAAModel[];
}

const AA_URL = "https://artificialanalysis.ai/leaderboards/models";
const AA_CACHE_HOURS = 24;

export class ModelService {
  private store: Store;
  private engine: EngineLocator;
  private aaCache: AACache | null = null;
  private aaPath: string;
  private refreshing: Promise<ModelInfo[]> | null = null;

  constructor(store: Store, engine: EngineLocator) {
    this.store = store;
    this.engine = engine;
    this.aaPath = join(store.baseDir, "aa-cache.json");
    this.loadAACache();
  }

  list(): ModelInfo[] {
    return this.store.data.models;
  }

  updatedAt(): number {
    return this.store.data.modelsUpdatedAt;
  }

  async refresh(): Promise<ModelInfo[]> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<ModelInfo[]> {
    const raw = await this.readPiModels();
    const aaIndex = this.buildAAIndex();
    const models: ModelInfo[] = [];
    for (const item of raw) {
      if (!item?.provider || !item?.id) continue;
      if (!Array.isArray(item.input) || !item.input.includes("text")) continue;
      const idLower = String(item.id).toLowerCase();
      if (/(embed|rerank|whisper|tts|speech|image-generation|moderation)/.test(idLower)) continue;
      const selector = item.selector || `${item.provider}/${item.id}`;
      const aa = this.lookupAA(aaIndex, item);
      const quality = aa?.intelligence ?? heuristicQuality(selector, item.name ?? "") * 0.55;
      models.push({
        provider: item.provider,
        id: item.id,
        selector,
        name: item.name ?? item.id,
        contextWindow: Number(item.contextWindow) || 0,
        maxTokens: item.maxTokens == null ? null : Number(item.maxTokens),
        reasoning: !!item.reasoning,
        thinking: Array.isArray(item.thinking) ? item.thinking : null,
        input: Array.isArray(item.input) ? item.input : ["text"],
        cost: {
          input: Math.max(0, Number(item.cost?.input) || 0),
          output: Math.max(0, Number(item.cost?.output) || 0),
          cacheRead: Math.max(0, Number(item.cost?.cacheRead) || 0),
          cacheWrite: Math.max(0, Number(item.cost?.cacheWrite) || 0),
        },
        available: item.available ?? this.hasAuth(item.provider),
        billing: providerBilling(item.provider),
        included: providerBilling(item.provider) === "subscription",
        aa,
        quality: Math.round(quality * 10) / 10,
      });
    }
    models.sort((a, b) => b.quality - a.quality || a.cost.output - b.cost.output);
    this.applyRecommendations(models);
    this.store.setModels(models);
    this.ensureDefaults(models);
    return models;
  }

  private hasAuth(provider: string): boolean {
    const local = new Set(["ollama", "lm-studio", "llama.cpp", "local", "apple"]);
    if (local.has(provider)) return true;
    const envMap: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GEMINI_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      opencode: "OPENCODE_API_KEY",
      "opencode-go": "OPENCODE_API_KEY",
      xai: "XAI_API_KEY",
      mistral: "MISTRAL_API_KEY",
      groq: "GROQ_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      nvidia: "NVIDIA_API_KEY",
      together: "TOGETHER_API_KEY",
      fireworks: "FIREWORKS_API_KEY",
      huggingface: "HF_TOKEN",
    };
    if (envMap[provider] && process.env[envMap[provider]]) return true;
    const authPath = join(this.store.baseDir, "pi-agent", "auth.json");
    if (!existsSync(authPath)) return false;
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
      return !!auth[provider];
    } catch {
      return false;
    }
  }
  private async readPiModels(): Promise<any[]> {
    const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
    const catalog = await importer("@earendil-works/pi-ai/providers/all");
    const models: any[] = [];
    for (const provider of catalog.getBuiltinProviders()) {
      for (const model of catalog.getBuiltinModels(provider)) models.push(model);
    }
    const customPath = join(this.store.baseDir, "pi-agent", "models.json");
    if (existsSync(customPath)) {
      try {
        const custom = JSON.parse(readFileSync(customPath, "utf8")) as { providers?: Record<string, any> };
        for (const [provider, config] of Object.entries(custom.providers ?? {})) {
          for (const model of Array.isArray(config?.models) ? config.models : []) {
            if (!model?.id) continue;
            models.push({
              id: model.id,
              name: model.name ?? model.id,
              api: model.api ?? config.api,
              provider,
              baseUrl: model.baseUrl ?? config.baseUrl,
              reasoning: !!model.reasoning,
              input: Array.isArray(model.input) ? model.input : ["text"],
              cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: Number(model.contextWindow) || 0,
              maxTokens: Number(model.maxTokens) || 0,
              available: true,
            });
          }
        }
      } catch {
        /* a broken custom catalog must not hide the built-in one */
      }
    }
    return models;
  }

  resolve(selector: string): ModelInfo | undefined {
    if (!selector) return undefined;
    const exact = this.list().find((m) => m.selector === selector);
    if (exact) return exact;
    const lower = selector.toLowerCase();
    return (
      this.list().find((m) => m.selector.toLowerCase() === lower) ??
      this.list().find((m) => m.id.toLowerCase() === lower) ??
      this.list().find((m) => m.name.toLowerCase() === lower) ??
      this.list().find((m) => m.selector.toLowerCase().includes(lower)) ??
      this.list().find((m) => m.name.toLowerCase().includes(lower))
    );
  }

  selectorForRole(role: string): string {
    const settings = this.store.settings.models as unknown as Record<string, string>;
    return settings[role] || settings.worker || settings.project || this.list()[0]?.selector || "";
  }

  ensureDefaults(models = this.list()): void {
    if (!models.length) return;
    const current = this.store.settings.models;
    const patch: Record<string, string> = {};
    for (const role of ["root", "group", "project", "worker", "naming", "memory"] as const) {
      const resolved = current[role] ? this.resolve(current[role]) : undefined;
      const invalid = !resolved || resolved.cost.input < 0 || resolved.cost.output < 0 || /auto-code|auto router/i.test(`${resolved.id} ${resolved.name}`);
      if (!current[role] || invalid) {
        patch[role] = defaultForRole(role, models, current.preferredProvider ?? "");
      }
    }
    if (Object.keys(patch).length) this.store.setSettings({ models: { ...current, ...patch } });
  }

  resetDefaults(): void {
    const models = this.list();
    if (!models.length) return;
    const current = this.store.settings.models;
    const patch: Record<string, string> = {};
    for (const role of ["root", "group", "project", "worker", "naming", "memory"] as const) {
      patch[role] = defaultForRole(role, models, current.preferredProvider ?? "");
    }
    this.store.setSettings({ models: { ...current, ...patch } });
    this.applyRecommendations(models);
    this.store.setModels(models);
  }

  async refreshAA(force = false): Promise<{ ok: boolean; source: string; count: number; error?: string }> {
    if (!force && this.aaCache && this.aaCache.models.length >= 20 && Date.now() - this.aaCache.fetchedAt < AA_CACHE_HOURS * 3_600_000) {
      await this.refresh();
      return { ok: true, source: this.aaCache.source, count: this.aaCache.models.length };
    }
    try {
      const models = await fetchAA();
      if (models.length < 20) throw new Error("Artificial Analysis returned an empty or incomplete model list");
      const wasHeuristic = this.store.settings.models.aaSource !== "artificial-analysis";
      this.aaCache = { fetchedAt: Date.now(), source: "artificialanalysis.ai", models };
      this.saveAACache();
      this.store.setSettings({
        models: {
          ...this.store.settings.models,
          lastAAUpdate: new Date().toISOString(),
          aaSource: "artificial-analysis",
        },
      });
      await this.refresh();
      if (wasHeuristic) this.resetDefaults();
      return { ok: true, source: "artificialanalysis.ai", count: models.length || this.list().length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.aaCache && this.aaCache.models.length >= 20) {
        await this.refresh();
        return { ok: true, source: this.aaCache.source, count: this.aaCache.models.length, error: message };
      }
      this.store.setSettings({
        models: { ...this.store.settings.models, aaSource: "heuristic" },
      });
      await this.refresh();
      return { ok: false, source: "heuristic", count: 0, error: message };
    }
  }

  private loadAACache(): void {
    if (!existsSync(this.aaPath)) return;
    try {
      this.aaCache = JSON.parse(readFileSync(this.aaPath, "utf8")) as AACache;
    } catch {
      this.aaCache = null;
    }
  }

  private saveAACache(): void {
    if (!this.aaCache) return;
    const tmp = `${this.aaPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.aaCache), "utf8");
    renameSync(tmp, this.aaPath);
  }

  private buildAAIndex(): Map<string, RawAAModel> {
    const index = new Map<string, RawAAModel>();
    for (const model of this.aaCache?.models ?? []) {
      if (!model || model.deprecated) continue;
      const keys = new Set<string>([normalizeModelName(model.slug), normalizeModelName(model.name)]);
      if (model.shortName) keys.add(normalizeModelName(model.shortName));
      for (const key of keys) {
        const existing = index.get(key);
        if (!existing || (model.intelligenceIndex ?? 0) > (existing.intelligenceIndex ?? 0)) index.set(key, model);
      }
    }
    return index;
  }

  private lookupAA(index: Map<string, RawAAModel>, item: any): AAScore | undefined {
    const candidates = [
      normalizeModelName(item.id),
      normalizeModelName(String(item.id).split("/").pop() ?? ""),
      normalizeModelName(item.name ?? ""),
      normalizeModelName(String(item.id).replace(/^[^/]+\//, "")),
    ];
    for (const candidate of candidates) {
      const direct = index.get(candidate);
      if (direct?.intelligenceIndex != null) return toAAScore(direct, this.aaCache?.source ?? "artificial-analysis");
    }
    for (const candidate of candidates) {
      for (const [key, model] of index) {
        if (!key || !candidate) continue;
        if (key === candidate || key.startsWith(`${candidate}-`) || candidate.startsWith(`${key}-`)) {
          if (model.intelligenceIndex != null) return toAAScore(model, this.aaCache?.source ?? "artificial-analysis");
        }
      }
    }
    for (const candidate of candidates) {
      const tokens = candidate.split("-").filter((token) => token.length > 1);
      if (tokens.length < 2) continue;
      let best: RawAAModel | undefined;
      for (const [key, model] of index) {
        if (model.intelligenceIndex == null) continue;
        const keyTokens = new Set(key.split("-"));
        if (tokens.every((token) => keyTokens.has(token))) {
          if (!best || (model.intelligenceIndex ?? 0) > (best.intelligenceIndex ?? 0)) best = model;
        }
      }
      if (best) return toAAScore(best, this.aaCache?.source ?? "artificial-analysis");
    }
    return undefined;
  }

  private applyRecommendations(models: ModelInfo[]): void {
    const roles = ["root", "group", "project", "worker", "naming", "memory"] as const;
    const preferred = this.store.settings.models.preferredProvider ?? "";
    for (const role of roles) {
      const selector = defaultForRole(role, models, preferred);
      const model = models.find((m) => m.selector === selector);
      if (model) model.recommended = role;
    }
  }
}

function defaultForRole(role: string, models: ModelInfo[], preferredProvider = ""): string {
  const isRouter = (model: ModelInfo) => /(^|[/-])(auto|router|auto-code)([/-]|$)/i.test(`${model.id} ${model.name}`) || /free models router/i.test(model.name);
  const subscription = !!preferredProvider && models.find((model) => model.provider === preferredProvider)?.billing === "subscription";
  const caps =
    role === "naming" || role === "memory"
      ? { output: 1, input: 0.5 }
      : { output: 15, input: 5 };
  const qualityFloor = role === "root" || role === "group" ? 55 : role === "project" || role === "worker" ? 40 : 0;
  const base = models.filter(
    (model) =>
      model.available &&
      model.input.includes("text") &&
      model.cost.input >= 0 &&
      model.cost.output >= 0 &&
      !model.id.includes(":batch") &&
      !/\(batch\)/i.test(model.name) &&
      !model.id.endsWith(":free") &&
      !model.id.includes("~") &&
      !/latest/i.test(model.id) &&
      model.contextWindow >= (role === "naming" ? 32_000 : 100_000),
  );
  const preferredModels = preferredProvider ? base.filter((model) => model.provider === preferredProvider) : [];
  const preferredClean = preferredModels.filter((model) => !isRouter(model));
  const clean = preferredClean.length ? preferredClean : base.filter((model) => !isRouter(model));
  if (preferredProvider === "opencode-go") {
    const curated = clean.find((model) => model.selector === "opencode-go/deepseek-v4.1-flash");
    if (curated) return curated.selector;
  }
  const capped = subscription ? clean : clean.filter((model) => model.cost.output <= caps.output && model.cost.input <= caps.input);
  const pool = capped.length ? capped : clean.length ? clean : base;
  if (!pool.length) return "";
  const aaPool = pool.filter((model) => model.aa?.agentic != null || model.aa?.intelligence != null);
  const qualityPool = qualityFloor > 0 ? aaPool.filter((model) => (model.aa?.agentic ?? model.aa?.intelligence ?? model.quality) >= qualityFloor) : aaPool;
  const target = role === "naming" || role === "memory" ? pool : qualityPool.length ? qualityPool : aaPool.length ? aaPool : pool;
  const exponent =
    role === "root" ? 0.18 : role === "group" ? 0.28 : role === "project" ? 0.42 : role === "worker" ? 0.55 : 0.8;
  const scored = target.map((model) => {
    const outputCost = Math.max(0, model.cost.output || 0);
    const inputCost = Math.max(0, model.cost.input || 0);
    const blended = inputCost * 0.3 + outputCost * 0.7;
    const agentic = model.aa?.agentic ?? model.aa?.intelligence ?? model.quality * 0.9;
    const value = agentic / Math.pow(blended + 1, exponent);
    const reasoningBonus = model.reasoning ? (role === "worker" ? 0.4 : 0.8) : 0;
    const contextBonus = Math.min(1.2, Math.log2(Math.max(1, model.contextWindow / 100_000)) * 0.3);
    const outputBonus = Math.min(1.5, Math.log2(Math.max(1, (model.maxTokens ?? 32_000) / 32_000)) * 0.25);
    const score = subscription && role !== "naming" && role !== "memory" ? agentic + contextBonus * 6 + outputBonus * 2 + reasoningBonus * 3 : value * 10 + reasoningBonus + contextBonus;
    return { model, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.model.selector ?? "";
}

function heuristicQuality(selector: string, name: string): number {
  const text = `${selector} ${name}`.toLowerCase();
  let score = 48;
  const boosts: Array<[RegExp, number]> = [
    [/opus/, 38],
    [/gpt-6/, 37],
    [/gpt-5\.6/, 32],
    [/sonnet/, 30],
    [/gemini[- ]?3/, 31],
    [/grok[- ]?4\.[567]/, 30],
    [/deepseek/, 24],
    [/qwen3\.8/, 28],
    [/qwen3\.7/, 25],
    [/qwen3\.6/, 23],
    [/glm[- ]?5/, 25],
    [/kimi/, 24],
    [/mistral[- ]?large/, 20],
    [/llama/, 16],
    [/haiku/, 18],
    [/flash|mini|nano|small/, -5],
    [/free|router/, -18],
    [/reason|thinking/, 4],
  ];
  for (const [pattern, delta] of boosts) if (pattern.test(text)) score += delta;
  if (/code/.test(text)) score += 3;
  if (/32b|30b|27b|14b|12b|9b|8b|7b|4b|3b/.test(text)) score -= 6;
  return Math.max(5, Math.min(99, score));
}

function toAAScore(model: RawAAModel, source: string): AAScore {
  const agentic = computeAgenticScore(model);
  const input = Math.max(0, model.price1mInputTokens ?? 0);
  const output = Math.max(0, model.price1mOutputTokens ?? 0);
  const blended = input * 0.3 + output * 0.7;
  return {
    intelligence: model.intelligenceIndex ?? undefined,
    agentic,
    price: model.price1mOutputTokens ?? undefined,
    speed: model.outputSpeed ?? undefined,
    value: agentic != null ? Math.round((agentic / Math.pow(blended + 1, 0.45)) * 100) / 100 : undefined,
    source: source === "artificialanalysis.ai" ? "artificial-analysis" : "baseline",
    updatedAt: new Date().toISOString(),
  };
}

function computeAgenticScore(model: RawAAModel): number | undefined {
  const scores = model.scores ?? {};
  const parts: Array<[number | null | undefined, number]> = [
    [scores["terminalbench-hard"], 0.35],
    [scores["tau2-bench"], 0.25],
    [scores["ifbench"], 0.15],
    [scores["artificial-analysis-long-context-reasoning"], 0.15],
    [scores["gpqa-diamond"], 0.1],
  ];
  let total = 0;
  let weight = 0;
  for (const [value, partWeight] of parts) {
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value * partWeight;
      weight += partWeight;
    }
  }
  if (weight >= 0.4) return (total / weight) * 100;
  if (model.intelligenceIndex != null) return model.intelligenceIndex;
  return undefined;
}

function normalizeModelName(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(max|high|medium|low|minimal|thinking|reasoning|free|batch|preview|beta|latest)\b/g, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/\./g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function fetchAA(): Promise<RawAAModel[]> {
  const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY || process.env.AA_API_KEY;
  if (apiKey) {
    const all: RawAAModel[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`, {
        headers: { "x-api-key": apiKey, "user-agent": "Perch" },
      });
      if (!response.ok) throw new Error(`Artificial Analysis API HTTP ${response.status}`);
      const json = (await response.json()) as any;
      for (const item of json.data ?? []) {
        all.push({
          slug: item.slug,
          name: item.name,
          shortName: item.name,
          deprecated: false,
          isReasoning: item.reasoning_model,
          contextWindowTokens: item.context_window_tokens,
          intelligenceIndex: item.evaluations?.artificial_analysis_intelligence_index ?? null,
          price1mInputTokens: item.pricing?.price_1m_input_tokens ?? null,
          price1mOutputTokens: item.pricing?.price_1m_output_tokens ?? null,
          outputSpeed: item.performance?.mean_output_tokens_per_second ?? null,
          scores: item.evaluations ?? {},
        });
      }
      if (!json.pagination?.has_more) break;
    }
    return all;
  }

  const response = await fetch(AA_URL, { headers: { "user-agent": "Mozilla/5.0 Perch" } });
  if (!response.ok) throw new Error(`Artificial Analysis page HTTP ${response.status}`);
  const html = await response.text();
  return parseAAHtml(html);
}

function parseAAHtml(html: string): RawAAModel[] {
  const marker = html.includes('initialModels\\":[') ? 'initialModels\\":[' : 'initialModels":[';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error("Artificial Analysis data block not found");
  const start = html.indexOf("[", markerIndex);
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error("Artificial Analysis data block is incomplete");
  const segment = html.slice(start, end).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const parsed = JSON.parse(segment) as RawAAModel[];
  return parsed
    .map((model) => ({
      ...model,
      slug: model.slug ?? model.release?.slug ?? "",
    }))
    .filter((model) => model && model.slug && model.name);
}




