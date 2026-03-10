import { describe, expect, it } from "vitest";
import { selectEntryMarket } from "../src/domain/entryPolicy.js";
import {
  computeMakerMissingLegPrice,
  evaluateForceWindowHedge,
  getImbalancePlan,
} from "../src/domain/recoveryPolicy.js";
import { getSnapshotAgeMs, isSnapshotStale } from "../src/domain/marketPolicy.js";

describe("domain policies", () => {
  it("computes imbalance plan for one-sided fills", () => {
    const upHeavy = getImbalancePlan(
      { upSize: 5, downSize: 3, differenceAbs: 2 },
      { upTokenId: "up", downTokenId: "down" },
    );
    expect(upHeavy).toEqual({
      filledLegTokenId: "up",
      missingLegTokenId: "down",
      missingAmount: 2,
    });

    const balanced = getImbalancePlan(
      { upSize: 5, downSize: 5, differenceAbs: 0 },
      { upTokenId: "up", downTokenId: "down" },
    );
    expect(balanced).toBeNull();
  });

  it("evaluates force-window hedge profitability", () => {
    const profitable = evaluateForceWindowHedge({
      entryPrice: 0.46,
      bestMissingAsk: 0.51,
      forceWindowFeeBuffer: 0.01,
      forceWindowMinProfitPerShare: 0.005,
    });
    expect(profitable.isProfitable).toBe(true);

    const notProfitable = evaluateForceWindowHedge({
      entryPrice: 0.46,
      bestMissingAsk: 0.535,
      forceWindowFeeBuffer: 0.01,
      forceWindowMinProfitPerShare: 0.005,
    });
    expect(notProfitable.isProfitable).toBe(false);
  });

  it("computes maker missing-leg prices within non-crossing bounds", () => {
    const price = computeMakerMissingLegPrice({
      bestBid: 0.45,
      bestAsk: 0.47,
      maxMissingPrice: 0.48,
      entryContinuousMakerOffset: 0.001,
    });

    expect(price).toBe(0.451);
  });

  it("prefers next market unless same condition as current", () => {
    const current = { slug: "current", conditionId: "c1" };
    const nextDifferent = { slug: "next", conditionId: "c2" };
    const nextSame = { slug: "next", conditionId: "c1" };

    expect(
      selectEntryMarket({
        currentMarket: current,
        nextMarket: nextDifferent,
        currentConditionId: "c1",
        getConditionId: (market) => market.conditionId ?? null,
      })?.slug,
    ).toBe("next");

    expect(
      selectEntryMarket({
        currentMarket: current,
        nextMarket: nextSame,
        currentConditionId: "c1",
        getConditionId: (market) => market.conditionId ?? null,
      })?.slug,
    ).toBe("current");
  });

  it("computes snapshot age and staleness with same thresholds", () => {
    expect(getSnapshotAgeMs(null, 10_000)).toBeNull();
    expect(getSnapshotAgeMs(8_000, 10_000)).toBe(2_000);

    expect(
      isSnapshotStale({
        snapshotUpdatedAtMs: null,
        loopSleepSeconds: 10,
        nowMs: 10_000,
      }),
    ).toBe(true);

    expect(
      isSnapshotStale({
        snapshotUpdatedAtMs: 9_000,
        loopSleepSeconds: 10,
        nowMs: 10_000,
      }),
    ).toBe(false);

    expect(
      isSnapshotStale({
        snapshotUpdatedAtMs: 1,
        loopSleepSeconds: 1,
        nowMs: 2_100,
      }),
    ).toBe(true);
  });
});
