import { describe, expect, it } from "vitest";
import { arePositionsEqual, summarizePositions } from "../ts-src/services/positionManager.js";

describe("position decision logic", () => {
  it("summarizes up/down balances by token id", () => {
    const summary = summarizePositions(
      [
        { asset: "up", conditionId: "c", size: 5 },
        { asset: "down", conditionId: "c", size: 4.99 }
      ],
      { upTokenId: "up", downTokenId: "down" }
    );

    expect(summary.upSize).toBe(5);
    expect(summary.downSize).toBe(4.99);
    expect(arePositionsEqual(summary, 0.01)).toBe(true);
  });

  it("uses outcome fallback mapping", () => {
    const summary = summarizePositions(
      [
        { asset: "x", conditionId: "c", size: 2, outcome: "Yes" },
        { asset: "y", conditionId: "c", size: 1, outcome: "No" }
      ],
      { upTokenId: "up", downTokenId: "down" }
    );

    expect(summary.upSize).toBe(2);
    expect(summary.downSize).toBe(1);
    expect(arePositionsEqual(summary, 0.01)).toBe(false);
  });
});
