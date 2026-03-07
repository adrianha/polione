import { describe, expect, it } from "vitest";
import type { BotConfig } from "../src/types/domain.js";
import { EvGuard } from "../src/services/evGuard.js";

const baseConfig: BotConfig = {
  dryRun: true,
  privateKey: `0x${"1".repeat(64)}`,
  signatureType: 0,
  chainId: 137,
  clobApiHost: "https://clob.polymarket.com",
  gammaApiBaseUrl: "https://gamma-api.polymarket.com",
  dataApiBaseUrl: "https://data-api.polymarket.com",
  marketSlugPrefix: "btc-updown-5m",
  marketIntervalSeconds: 300,
  orderPrice: 0.46,
  orderSize: 5,
  positionEqualityTolerance: 0.01,
  forceSellThresholdSeconds: 30,
  minSecondsToCloseForEntry: 60,
  loopSleepSeconds: 10,
  positionRecheckSeconds: 60,
  requestTimeoutMs: 30000,
  requestRetries: 0,
  requestRetryBackoffMs: 0,
  evGuardEnabled: true,
  evMinNetPerShare: 0.01,
  evEstimatedFeeBps: 0,
  evEstimatedSlippagePerShare: 0.002,
  evEstimatedForceSellPenaltyPerShare: 0.004,
  evEstimatedPartialFillPenaltyPerShare: 0.002,
  logLevel: "info"
};

describe("ev guard", () => {
  it("allows entries when net EV exceeds threshold", () => {
    const guard = new EvGuard(baseConfig);
    const evaluation = guard.evaluatePairedBuy(0.45, 0.45, 5, "live");
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.netPerShare).toBeGreaterThanOrEqual(baseConfig.evMinNetPerShare);
    expect(evaluation.priceSource).toBe("live");
  });

  it("blocks entries when net EV is below threshold", () => {
    const guard = new EvGuard(baseConfig);
    const evaluation = guard.evaluatePairedBuy(0.497, 0.497, 5, "config_fallback");
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.netPerShare).toBeLessThan(baseConfig.evMinNetPerShare);
    expect(evaluation.priceSource).toBe("config_fallback");
  });
});
