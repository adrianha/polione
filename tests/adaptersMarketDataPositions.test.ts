import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { BotConfig } from "../src/types/domain.js";
import { makeMarketData } from "../src/adapters/marketData.live.js";
import { makePositions } from "../src/adapters/positions.live.js";

const baseConfig: BotConfig = {
  dryRun: true,
  privateKey: `0x${"1".repeat(64)}`,
  signatureType: 0,
  chainId: 137,
  clobApiHost: "https://clob.polymarket.com",
  clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  enableClobWs: false,
  wsQuotesMaxAgeMs: 2000,
  wsReconnectDelayMs: 2000,
  gammaApiBaseUrl: "https://gamma-api.polymarket.com",
  dataApiBaseUrl: "https://data-api.polymarket.com",
  marketSlugPrefix: "btc-updown-5m",
  marketIntervalSeconds: 300,
  orderPrice: 0.46,
  orderSize: 5,
  positionEqualityTolerance: 0.01,
  forceSellThresholdSeconds: 30,
  loopSleepSeconds: 10,
  currentLoopSleepSeconds: 3,
  positionRecheckSeconds: 60,
  entryReconcileSeconds: 15,
  entryReconcilePollSeconds: 3,
  entryCancelOpenOrders: true,
  entryMaxRepriceAttempts: 2,
  entryRepriceStep: 0.01,
  entryMaxPrice: 0.5,
  entryMaxSpread: 0.03,
  entryDepthPriceBand: 0.02,
  entryDepthUsageRatio: 0.6,
  forceWindowFeeBuffer: 0.01,
  forceWindowMinProfitPerShare: 0.005,
  entryContinuousRepriceEnabled: true,
  entryContinuousRepriceIntervalMs: 1500,
  entryContinuousMinPriceDelta: 0.002,
  entryContinuousMaxDurationSeconds: 45,
  entryContinuousMakerOffset: 0.001,
  requestTimeoutMs: 30000,
  requestRetries: 0,
  requestRetryBackoffMs: 0,
  stateFilePath: ".bot-state.test.json",
  logLevel: "info",
};

describe("effect adapters: market data + positions", () => {
  it("validates gamma market payload shape", async () => {
    const gammaClient = {
      getMarketBySlug: vi.fn(async () => ({ slug: "btc-updown-5m-1", conditionId: "cond-1", tokens: [] })),
    };

    const adapter = makeMarketData({ config: baseConfig, gammaClient: gammaClient as never });
    const market = await Effect.runPromise(adapter.findCurrentActiveMarket);

    expect(market?.slug).toBe("btc-updown-5m-1");
    expect(gammaClient.getMarketBySlug).toHaveBeenCalled();
  });

  it("fails when gamma payload has invalid typed fields", async () => {
    const gammaClient = {
      getMarketBySlug: vi.fn(async () => ({ slug: 123 })),
    };

    const adapter = makeMarketData({ config: baseConfig, gammaClient: gammaClient as never });
    await expect(Effect.runPromise(adapter.findCurrentActiveMarket)).rejects.toThrow();
  });

  it("fails when market utility fields are malformed", () => {
    const gammaClient = {
      getMarketBySlug: vi.fn(async () => null),
    };
    const adapter = makeMarketData({ config: baseConfig, gammaClient: gammaClient as never });

    expect(() =>
      adapter.getConditionId({
        slug: "x",
        conditionId: "",
      } as never),
    ).toThrow();

    expect(() =>
      adapter.getSecondsToMarketClose({
        slug: "x",
        endDate: "not-a-date",
      } as never),
    ).toThrow();
  });

  it("validates positions payload", async () => {
    const dataClient = {
      getPositions: vi.fn(async () => [{ asset: "up", conditionId: "c1", size: "5" }]),
    };

    const adapter = makePositions(dataClient as never);
    const positions = await Effect.runPromise(adapter.getPositions("0xabc", "c1"));

    expect(positions[0]?.size).toBe(5);
  });

  it("rejects negative position sizes", async () => {
    const dataClient = {
      getPositions: vi.fn(async () => [{ asset: "up", conditionId: "c1", size: -1 }]),
    };

    const adapter = makePositions(dataClient as never);
    await expect(Effect.runPromise(adapter.getPositions("0xabc", "c1"))).rejects.toThrow();
  });
});
