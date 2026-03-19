import { describe, expect, it } from "vitest";
import { createV3Config } from "../src/bot-v3/config.js";
import { V3SignalService } from "../src/bot-v3/services/signalService.js";
import type { BotConfig } from "../src/types/domain.js";
import type { V3MarketSnapshot } from "../src/bot-v3/types.js";

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
  redeemLoopSleepSeconds: 60,
  redeemEnabled: true,
  redeemMaxRetries: 8,
  redeemRetryBackoffMs: 60_000,
  redeemSuccessCooldownMs: 300_000,
  redeemMaxPerLoop: 20,
  redeemTerminalStateTtlMs: 604_800_000,
  positionRecheckSeconds: 60,
  entryReconcileSeconds: 15,
  entryReconcilePollSeconds: 3,
  entryCancelOpenOrders: true,
  forceWindowFeeBuffer: 0.01,
  forceWindowMinProfitPerShare: 0.005,
  entryContinuousRepriceEnabled: true,
  entryContinuousRepriceIntervalMs: 1500,
  entryContinuousMinPriceDelta: 0.002,
  entryContinuousMaxDurationSeconds: 45,
  entryContinuousMakerOffset: 0.001,
  entryRecoveryHorizonSeconds: 120,
  entryRecoveryExtraProfitMax: 0.01,
  entryRecoveryMinSizeFraction: 0.35,
  entryRecoveryPassiveOffsetMax: 0.004,
  requestTimeoutMs: 30000,
  requestRetries: 0,
  requestRetryBackoffMs: 0,
  stateFilePath: ".bot-state.test.json",
  v3MarketSlugPrefix: "sol-updown-5m",
  v3EntryThreshold: 0.85,
  v3TakeProfitPrice: 0.95,
  v3StopLossPrice: 0.75,
  v3OrderSize: 5,
  v3MaxEntryAsk: 0.9,
  v3MaxLivePositions: 1,
  v3LoopIntervalSeconds: 2,
  v3OrderFillTimeoutMs: 10000,
  v3OrderFillPollIntervalMs: 1000,
  v3StateFilePath: ".bot-v3-state.test.json",
  logLevel: "info",
};

const baseSnapshot: V3MarketSnapshot = {
  market: { slug: "sol-updown-5m-123", conditionId: "cond-1" },
  slug: "sol-updown-5m-123",
  conditionId: "cond-1",
  secondsToClose: 120,
  fetchedAtMs: Date.now(),
  tokens: [
    { tokenId: "up", outcome: "Up", bestBid: 0.83, bestAsk: 0.86 },
    { tokenId: "down", outcome: "Down", bestBid: 0.12, bestAsk: 0.14 },
  ],
};

describe("bot v3 signal service", () => {
  it("returns a signal for the favorite when bestAsk meets threshold", () => {
    const service = new V3SignalService(createV3Config(baseConfig));
    const signal = service.evaluate(baseSnapshot);

    expect(signal).toEqual({
      conditionId: "cond-1",
      slug: "sol-updown-5m-123",
      tokenId: "up",
      outcome: "Up",
      bestBid: 0.83,
      bestAsk: 0.86,
      secondsToClose: 120,
    });
  });

  it("rejects favorites priced above the max entry ask", () => {
    const service = new V3SignalService(createV3Config(baseConfig));
    const signal = service.evaluate({
      ...baseSnapshot,
      tokens: [
        { tokenId: "up", outcome: "Up", bestBid: 0.9, bestAsk: 0.91 },
        { tokenId: "down", outcome: "Down", bestBid: 0.07, bestAsk: 0.09 },
      ],
    });

    expect(signal).toBeNull();
  });

  it("rejects ties and expired markets", () => {
    const service = new V3SignalService(createV3Config(baseConfig));

    expect(
      service.evaluate({
        ...baseSnapshot,
        tokens: [
          { tokenId: "up", outcome: "Up", bestBid: 0.84, bestAsk: 0.85 },
          { tokenId: "down", outcome: "Down", bestBid: 0.84, bestAsk: 0.85 },
        ],
      }),
    ).toBeNull();

    expect(
      service.evaluate({
        ...baseSnapshot,
        secondsToClose: 0,
      }),
    ).toBeNull();
  });
});
