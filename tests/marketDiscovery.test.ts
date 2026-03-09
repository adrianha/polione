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
