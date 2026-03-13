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
  builderApiKey2: undefined,
  builderApiSecret2: undefined,
  builderApiPassphrase2: undefined,
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
  requestTimeoutMs: 30_000,
  requestRetries: 0,
  requestRetryBackoffMs: 0,
  stateFilePath: ".bot-state.test.json",
  logLevel: "info",
};

describe("market discovery integration", () => {
  it("checks slug generation and condition id extraction", async () => {
    const expected: MarketRecord = {
      slug: "btc-updown-5m-1700000100",
      conditionId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clobTokenIds: ["up-1", "down-1"],
    };

    const gammaClient = {
      getMarketBySlug: async (slug: string): Promise<MarketRecord | null> => {
        if (slug === expected.slug) {
          return expected;
        }
        return null;
      },
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
