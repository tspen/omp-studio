import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AAScore, ModelInfo } from "../../shared/types";
import type { EngineLocator } from "../engine/engine-locator";
import type { Store } from "./store";

interface RawAAModel {
  slug: string;
  name: string;
  shortName?: string;
  deprecated?: boolean;
  isReasoning?: boolean;
  contextWindowTokens?: number;
  intelligenceIndex?: number | null;
  price1mInputTokens?: number | null;
  price1mOutputTokens?: number | null;
  outputSpeed?: number | null;
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
    const raw = await this.readOmpModels();
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
        available: true,
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

  private readOmpModels(): Promise<any[]> {
    const exe = this.engine.resolveForSpawn();
    return new Promise((resolve, reject) => {
      execFile(
        exe,
        ["models", "--json"],
        { timeout: 120_000, maxBuffer: 40 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error && !stdout) {
            reject(new Error(`Could not read OMP model catalog: ${stderr || error.message}`));
            return;
          }
          try {
            const parsed = JSON.parse(stdout);
            const models = Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed) ? parsed : [];
            resolve(models);
          } catch (parseError) {
            reject(new Error(`Could not parse OMP model catalog: ${String(parseError)}`));
          }
        },
      );
    });
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
        patch[role] = defaultForRole(role, models);
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
      patch[role] = defaultForRole(role, models);
    }
    this.store.setSettings({ models: { ...current, ...patch } });
    this.applyRecommendations(models);
    this.store.setModels(models);
  }

  async refreshAA(force = false): Promise<{ ok: boolean; source: string; count: number; error?: string }> {
    if (!force && this.aaCache && Date.now() - this.aaCache.fetchedAt < AA_CACHE_HOURS * 3_600_000) {
      await this.refresh();
      return { ok: true, source: this.aaCache.source, count: this.aaCache.models.length };
    }
    try {
      const models = await fetchAA();
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
      if (this.aaCache) {
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
    for (const role of roles) {
      const selector = defaultForRole(role, models);
      const model = models.find((m) => m.selector === selector);
      if (model) model.recommended = role;
    }
  }
}

function defaultForRole(role: string, models: ModelInfo[]): string {
  const isRouter = (model: ModelInfo) => /(^|[/-])(auto|router|auto-code)([/-]|$)/i.test(`${model.id} ${model.name}`) || /free models router/i.test(model.name);
  const clean = models.filter(
    (model) =>
      model.available &&
      model.input.includes("text") &&
      model.cost.input >= 0 &&
      model.cost.output >= 0 &&
      !model.id.includes(":batch") &&
      !model.id.includes("~") &&
      !/latest/i.test(model.id) &&
      model.contextWindow >= (role === "naming" ? 32_000 : 100_000),
  );
  const withoutRouters = clean.filter((model) => !isRouter(model));
  const usable = withoutRouters.length ? withoutRouters : clean;
  const pool = usable.length ? usable : models.filter((model) => model.cost.input >= 0 && model.cost.output >= 0);
  if (!pool.length) return "";
  if (role === "naming" || role === "memory") {
    const cheap = [...pool].sort((a, b) => {
      const aCost = a.cost.output + a.cost.input * 4;
      const bCost = b.cost.output + b.cost.input * 4;
      const aScore = a.quality - aCost * (role === "naming" ? 1.4 : 0.8) + (a.aa?.intelligence != null ? 3 : 0);
      const bScore = b.quality - bCost * (role === "naming" ? 1.4 : 0.8) + (b.aa?.intelligence != null ? 3 : 0);
      return bScore - aScore;
    });
    return cheap[0]?.selector ?? "";
  }
  const scored = pool.map((model) => {
    const outputCost = Math.max(0, model.cost.output || 0);
    const inputCost = Math.max(0, model.cost.input || 0);
    const cheapness = role === "worker" ? 0.65 : role === "project" ? 0.35 : role === "group" ? 0.1 : 0.05;
    const reasoningBonus = model.reasoning ? (role === "worker" ? 2 : 4) : 0;
    const contextBonus = Math.min(4, Math.log2(Math.max(1, model.contextWindow / 100_000)) * 1.2);
    const aaBonus = model.aa?.intelligence != null ? 6 : 0;
    return { model, score: model.quality + reasoningBonus + contextBonus + aaBonus - (outputCost * 0.8 + inputCost * 4) * cheapness };
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
  return {
    intelligence: model.intelligenceIndex ?? undefined,
    price: model.price1mOutputTokens ?? undefined,
    speed: model.outputSpeed ?? undefined,
    source: source === "artificialanalysis.ai" ? "artificial-analysis" : "baseline",
    updatedAt: new Date().toISOString(),
  };
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
        headers: { "x-api-key": apiKey, "user-agent": "OMP-Studio" },
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
        });
      }
      if (!json.pagination?.has_more) break;
    }
    return all;
  }

  const response = await fetch(AA_URL, { headers: { "user-agent": "Mozilla/5.0 OMP-Studio" } });
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
  return parsed.filter((model) => model && model.slug && model.name);
}
