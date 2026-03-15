import type { Logger } from "pino";
import { StateStore } from "../../../utils/stateStore.js";

export class TrackedMarketState {
  private readonly trackedMarkets = new Set<string>();

  constructor(
    private readonly stateStore: StateStore,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<void> {
    const loaded = await this.stateStore.loadTrackedMarkets();
    for (const conditionId of loaded) {
      this.trackedMarkets.add(conditionId);
    }
  }

  has(conditionId: string): boolean {
    return this.trackedMarkets.has(conditionId);
  }

  values(): Set<string> {
    return this.trackedMarkets;
  }

  async add(conditionId: string): Promise<void> {
    if (this.trackedMarkets.has(conditionId)) {
      return;
    }

    this.trackedMarkets.add(conditionId);
    try {
      await this.stateStore.saveTrackedMarkets(this.trackedMarkets);
    } catch (error) {
      this.logger.error(
        {
          conditionId,
          error,
        },
        "Failed to persist tracked market state",
      );
      throw error;
    }
  }
}
