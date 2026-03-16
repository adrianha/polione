import { describe, expect, it } from "vitest";
import type { BotConfig, MarketRecord } from "../src/types/domain.js";
import { MarketDiscoveryService } from "../src/services/marketDiscovery.js";

const config: BotConfig = {
  dryRun: true,
  privateKey: `0x${"1".repeat(64)}`,
  signatureType: 0,
  chainId: 137,
  clobApiHost: "https://clob.polymarket.com",
  clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  enableClobWs: false,
  wsQuotesMaxAgeMs: 2000,
  wsReconnectDelayMs: 2000,
  telegramBotToken: undefined,
  telegramChatId: undefined,
  gammaApiBaseUrl: "https://gamma-api.polymarket.com",
  dataApiBaseUrl: "https://data-api.polymarket.com",
  marketSlugPrefix: "btc-updown-5m",
  marketIntervalSeconds: 300,
  orderPrice: 0.46,
  orderSize: 5,
  positionEqualityTolerance: 0.01,
  forceSellThresholdSeconds: 30,
  marketPollMs: 10_000,
  marketUrgentPollMs: 3_000,
  redeemPollMs: 60_000,
  telegramPollMs: 10_000,
  redeemEnabled: true,
  redeemMaxRetries: 8,
  redeemRetryBackoffMs: 60_000,
  redeemSuccessCooldownMs: 300_000,
  redeemMaxPerLoop: 20,
  redeemTerminalStateTtlMs: 604_800_000,
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
  logLevel: "info",
};

describe("market discovery token parsing", () => {
  it("parses clobTokenIds string", () => {
    const gamma = {
      getMarketBySlug: async (_slug: string): Promise<MarketRecord | null> => null,
    };
    const svc = new MarketDiscoveryService(config, gamma as never);
    const tokens = svc.getTokenIds({ clobTokenIds: '["up-id","down-id"]' });
    expect(tokens).toEqual({ upTokenId: "up-id", downTokenId: "down-id" });
  });

  it("parses tokens array fallback", () => {
    const gamma = {
      getMarketBySlug: async (_slug: string): Promise<MarketRecord | null> => null,
    };
    const svc = new MarketDiscoveryService(config, gamma as never);
    const tokens = svc.getTokenIds({
      tokens: [{ token_id: "yes-token" }, { token_id: "no-token" }],
    });
    expect(tokens).toEqual({ upTokenId: "yes-token", downTokenId: "no-token" });
  });
});
