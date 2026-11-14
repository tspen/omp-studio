import { execFile } from "node:child_process";
import type { ProviderUsage, UsageSnapshot } from "../../shared/types";
import type { EngineLocator } from "../engine/engine-locator";
import type { Store } from "./store";

export class UsageService {
  private store: Store;
  private engine: EngineLocator;

  constructor(store: Store, engine: EngineLocator) {
    this.store = store;
    this.engine = engine;
  }

  async refresh(): Promise<UsageSnapshot> {
    const exe = this.engine.resolveForSpawn();
    const raw = await new Promise<any>((resolve, reject) => {
      execFile(
        exe,
        ["usage", "--json"],
        { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error && !stdout) reject(new Error(stderr || error.message));
          else {
            try {
              resolve(JSON.parse(stdout));
            } catch (parseError) {
              reject(parseError);
            }
          }
        },
      );
    });
    const providers: ProviderUsage[] = [];
    for (const report of raw?.reports ?? []) {
      const limits: any[] = Array.isArray(report.limits) ? report.limits : [];
      const limit = limits
        .slice()
        .sort((a, b) => (a.amount?.remainingFraction ?? 1) - (b.amount?.remainingFraction ?? 1))[0];
      providers.push({
        provider: report.provider,
        label: limit?.label ?? report.provider,
        used: limit?.amount?.used,
        limit: limit?.amount?.limit,
        remaining: limit?.amount?.remaining,
        unit: limit?.amount?.unit,
        resetsAt: limit?.window?.resetsAt,
        status: limit?.status ?? (report.metadata?.allowed === false ? "blocked" : "ok"),
        metadata: {
          planType: report.metadata?.planType,
          email: report.metadata?.email,
          limitReached: report.metadata?.limitReached,
          limits: limits.map((item) => ({
            id: item.id,
            label: item.label,
            used: item.amount?.used,
            limit: item.amount?.limit,
            remaining: item.amount?.remaining,
            unit: item.amount?.unit,
            resetsAt: item.window?.resetsAt,
            status: item.status,
          })),
        },
      });
    }
    const usage: UsageSnapshot = {
      ...this.store.data.usage,
      generatedAt: Date.now(),
      providers,
    };
    this.store.setUsage(usage);
    return usage;
  }
}
