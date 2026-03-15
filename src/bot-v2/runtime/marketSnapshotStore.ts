import type { MarketRecord } from "../../types/domain.js";

export interface MarketSnapshot {
  currentMarket: MarketRecord | null;
  nextMarket: MarketRecord | null;
  updatedAtMs: number | null;
}

export class MarketSnapshotStore {
  private snapshot: MarketSnapshot = {
    currentMarket: null,
    nextMarket: null,
    updatedAtMs: null,
  };

  setSnapshot(currentMarket: MarketRecord | null, nextMarket: MarketRecord | null): void {
    this.snapshot = {
      currentMarket,
      nextMarket,
      updatedAtMs: Date.now(),
    };
  }

  getSnapshot(): MarketSnapshot {
    return this.snapshot;
  }

  getSnapshotAgeMs(): number | null {
    if (this.snapshot.updatedAtMs === null) {
      return null;
    }
    return Date.now() - this.snapshot.updatedAtMs;
  }

  isStale(maxAgeMs: number): boolean {
    const age = this.getSnapshotAgeMs();
    if (age === null) {
      return true;
    }
    return age > maxAgeMs;
  }
}
