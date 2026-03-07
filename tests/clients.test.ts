import { describe, expect, it } from "vitest";
import type { BotConfig, MarketRecord } from "../src/types/domain.js";
import { MarketDiscoveryService } from "../src/services/marketDiscovery.js";

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
  requestTimeoutMs: 30_000,
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

describe("market discovery integration", () => {
  it("checks slug generation and condition id extraction", async () => {
    const expected: MarketRecord = {
      slug: "btc-updown-5m-1700000100",
      conditionId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clobTokenIds: ["up-1", "down-1"]
    };

    const gammaClient = {
      getMarketBySlug: async (slug: string): Promise<MarketRecord | null> => {
        if (slug === expected.slug) {
          return expected;
        }
        return null;
      }
    };

    const service = new MarketDiscoveryService(config, gammaClient as never);
    const slug = service.generateSlug(1_700_000_100);
    const market = await gammaClient.getMarketBySlug(slug);

    expect(slug).toBe("btc-updown-5m-1700000100");
    expect(market?.slug).toBe(expected.slug);
    expect(service.getConditionId(market!)).toBe(expected.conditionId);
    expect(service.getTokenIds(market!)).toEqual({ upTokenId: "up-1", downTokenId: "down-1" });
  });
});
