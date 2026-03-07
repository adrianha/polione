import { describe, expect, it } from "vitest";
import type { BotConfig, MarketRecord } from "../src/types/domain.js";
import { MarketDiscoveryService } from "../src/services/marketDiscovery.js";

const config: BotConfig = {
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
  logLevel: "info"
};

describe("entry time guard support", () => {
  it("returns small positive seconds-to-close for near-end market", () => {
    const gamma = {
      getMarketBySlug: async (_slug: string): Promise<MarketRecord | null> => null
    };
    const service = new MarketDiscoveryService(config, gamma as never);
    const endDate = new Date(Date.now() + 45_000).toISOString();
    const seconds = service.getSecondsToMarketClose({ endDate });

    expect(seconds).not.toBeNull();
    expect(seconds!).toBeLessThanOrEqual(45);
    expect(seconds!).toBeGreaterThanOrEqual(1);
  });

  it("returns null when end date is missing", () => {
    const gamma = {
      getMarketBySlug: async (_slug: string): Promise<MarketRecord | null> => null
    };
    const service = new MarketDiscoveryService(config, gamma as never);

    expect(service.getSecondsToMarketClose({})).toBeNull();
  });
});
