import { describe, expect, it } from "vitest";
import type { BotConfig, MarketRecord } from "../ts-src/types/domain.js";
import { MarketDiscoveryService } from "../ts-src/services/marketDiscovery.js";

const config: BotConfig = {
  dryRun: true,
  enableLiveTrading: false,
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

describe("market discovery token parsing", () => {
  it("parses clobTokenIds string", () => {
    const gamma = {
      getMarketBySlug: async (_slug: string): Promise<MarketRecord | null> => null
    };
    const svc = new MarketDiscoveryService(config, gamma as never);
    const tokens = svc.getTokenIds({ clobTokenIds: '["up-id","down-id"]' });
    expect(tokens).toEqual({ upTokenId: "up-id", downTokenId: "down-id" });
  });

  it("parses tokens array fallback", () => {
    const gamma = {
      getMarketBySlug: async (_slug: string): Promise<MarketRecord | null> => null
    };
    const svc = new MarketDiscoveryService(config, gamma as never);
    const tokens = svc.getTokenIds({
      tokens: [{ token_id: "yes-token" }, { token_id: "no-token" }]
    });
    expect(tokens).toEqual({ upTokenId: "yes-token", downTokenId: "no-token" });
  });
});
