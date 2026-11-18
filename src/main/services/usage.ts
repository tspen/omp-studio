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
    // Pi reports token/cost totals per session, not a global provider window.
    // The dashboard uses the app's own thread totals and provider snapshots are
    // populated when a provider exposes them.
    const usage: UsageSnapshot = {
      ...this.store.data.usage,
      generatedAt: Date.now(),
      meteredCost: this.store.data.usage.meteredCost ?? this.store.data.usage.totalCost ?? 0,
      referenceCost: this.store.data.usage.referenceCost ?? 0,
      providers: [],
    };
    this.store.setUsage(usage);
    return usage;
  }
}
