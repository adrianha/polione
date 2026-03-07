import { describe, expect, it } from "vitest";
import { getCurrentEpochTimestamp, getNextEpochTimestamp, secondsUntil } from "../ts-src/utils/time.js";

describe("time utils", () => {
  it("rounds to current and next epoch", () => {
    const now = 1_700_000_123;
    expect(getCurrentEpochTimestamp(now, 300)).toBe(1_700_000_100);
    expect(getNextEpochTimestamp(now, 300)).toBe(1_700_000_400);
  });

  it("computes seconds until target", () => {
    expect(secondsUntil(110, 100)).toBe(10);
    expect(secondsUntil(90, 100)).toBe(-10);
  });
});
