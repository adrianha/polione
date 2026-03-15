import { describe, expect, it, vi } from "vitest";
import type { BotConfig, MarketRecord } from "../src/types/domain.js";
import { EntryService } from "../src/bot-v2/domain/entry/entryService.js";

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
  telegramBotToken: undefined,
  telegramChatId: undefined,
  builderApiKey2: undefined,
  builderApiSecret2: undefined,
  builderApiPassphrase2: undefined,
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
  entryReconcileSeconds: 1,
  entryReconcilePollSeconds: 1,
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

describe("bot v2 entry service", () => {
  it("prefers next market when different condition", () => {
    const marketDiscovery = {
      getConditionId: vi.fn((market: MarketRecord) => market.conditionId ?? null),
    } as any;

    const service = new EntryService(
      baseConfig,
      { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      marketDiscovery,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const currentMarket: MarketRecord = { conditionId: "cond-1", slug: "current" };
    const nextMarket: MarketRecord = { conditionId: "cond-2", slug: "next" };
    const selected = service.selectEntryMarket({
      currentMarket,
      nextMarket,
      currentConditionId: "cond-1",
    });

    expect(selected?.conditionId).toBe("cond-2");
  });

  it("uses current market when next market matches current condition", () => {
    const marketDiscovery = {
      getConditionId: vi.fn((market: MarketRecord) => market.conditionId ?? null),
    } as any;

    const service = new EntryService(
      baseConfig,
      { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      marketDiscovery,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const currentMarket: MarketRecord = { conditionId: "cond-1", slug: "current" };
    const nextMarket: MarketRecord = { conditionId: "cond-1", slug: "next" };
    const selected = service.selectEntryMarket({
      currentMarket,
      nextMarket,
      currentConditionId: "cond-1",
    });

    expect(selected?.conditionId).toBe("cond-1");
    expect(selected?.slug).toBe("current");
  });
});
