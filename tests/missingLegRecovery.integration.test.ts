import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { BotConfig, MarketRecord } from "../src/types/domain.js";
import { PolymarketBot } from "../src/bot.js";

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

const market: MarketRecord = {
  slug: "btc-updown-5m-test",
  conditionId: "cond-1",
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const createBotHarness = async (configOverrides?: Partial<BotConfig>) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pm-missing-leg-it-"));
  const bot = new PolymarketBot(
    {
      ...baseConfig,
      ...configOverrides,
      stateFilePath: path.join(tempDir, "state.json"),
    },
    logger,
  ) as any;

  bot.marketDiscovery = {
    getTokenIds: vi.fn(() => ({ upTokenId: "up-token", downTokenId: "down-token" })),
    getConditionId: vi.fn(() => "cond-1"),
    getSecondsToMarketClose: vi.fn(() => 120),
  };
  bot.clobWsClient = { ensureSubscribed: vi.fn(), clearQuotes: vi.fn() };
  bot.clobClient = { getUsdcBalance: vi.fn(async () => 100) };
  bot.dataClient = { getPositions: vi.fn(async () => []) };
  bot.tradingEngine = {
    placePairedLimitBuysAtPrice: vi.fn(async () => ({ ok: true })),
    placeSingleLimitBuyAtPrice: vi.fn(async () => ({ ok: true })),
    reconcilePairedEntry: vi.fn(async () => ({
      status: "balanced",
      attempts: 1,
      finalSummary: { upSize: 5, downSize: 5, differenceAbs: 0 },
    })),
    getFilledAveragePriceForOrder: vi.fn(async () => ({
      avgPrice: 0.46,
      filledSize: 5,
      source: "fallback",
      orderId: null,
    })),
    getTopOfBook: vi.fn(async () => ({ bestBid: 0.35, bestAsk: 0.36 })),
    getTopOfBookForCondition: vi.fn(async () => ({
      bestBid: 0.35,
      bestAsk: 0.36,
      topBids: [0.35, 0.34, 0.33],
      topAsks: [0.36, 0.37, 0.38],
      rawTopBids: [0.35, 0.34, 0.33],
      rawTopAsks: [0.36, 0.37, 0.38],
    })),
    getBestAskPrice: vi.fn(async () => 0.4),
    getBestAskPriceForCondition: vi.fn(async () => 0.4),
    hasOpenBuyOrderAtPrice: vi.fn(async () => false),
    getOpenBuyExposure: vi.fn(async () => 0),
    getOrderFillState: vi.fn(async () => null),
    extractOrderId: vi.fn(() => null),
    cancelEntryOpenOrders: vi.fn(async () => []),
    completeMissingLegForHedge: vi.fn(async () => ({ ok: true })),
  };
  bot.relayerClient = { isAvailable: vi.fn(() => false) };
  bot.settlementService = {
    mergeEqualPositions: vi.fn(async () => ({ ok: true })),
    redeemResolvedPositions: vi.fn(async () => ({ ok: true, meta: { builderLabel: "builder1" } })),
  };
  bot.notify = vi.fn(async () => undefined);
  bot.notifyPlacementSuccessOnce = vi.fn(async () => undefined);
  bot.notifyEntryFilledOnce = vi.fn(async () => undefined);

  return { bot, tempDir };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("missing-leg recovery integration", () => {
  it("skips placement when horizon-scaled recovery size is below minimum order size", async () => {
    const { bot, tempDir } = await createBotHarness();
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 4 },
        { asset: "down-token", conditionId: "cond-1", size: 2 },
      ])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 4 },
        { asset: "down-token", conditionId: "cond-1", size: 2 },
      ]);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips placement when mid-window scaled size is below minimum order size", async () => {
    const { bot, tempDir } = await createBotHarness();
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 60);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 4 },
        { asset: "down-token", conditionId: "cond-1", size: 2 },
      ])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 4 },
        { asset: "down-token", conditionId: "cond-1", size: 2 },
      ]);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips best-ask cross when resulting size is below minimum order size", async () => {
    const { bot, tempDir } = await createBotHarness();
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);
    bot.tradingEngine.getTopOfBookForCondition = vi.fn(async () => ({
      bestBid: 0.01,
      bestAsk: 0.06,
      topBids: [0.01],
      topAsks: [0.06],
      rawTopBids: [0.01],
      rawTopAsks: [0.06],
    }));
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([{ asset: "down-token", conditionId: "cond-1", size: 4 }])
      .mockResolvedValueOnce([{ asset: "down-token", conditionId: "cond-1", size: 4 }]);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips re-order when previous placement is too recent and price delta is tiny", async () => {
    const { bot, tempDir } = await createBotHarness();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 31);
    bot.tradingEngine.getTopOfBookForCondition = vi.fn(async () => ({
      bestBid: 0.349,
      bestAsk: 0.351,
      topBids: [0.349, 0.348],
      topAsks: [0.351, 0.352],
      rawTopBids: [0.349, 0.348],
      rawTopAsks: [0.351, 0.352],
    }));
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }])
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }]);

    bot.recentRecoveryPlacements.set("cond-1", {
      placedAtMs: 1_000_000,
      summary: { upSize: 4, downSize: 0, differenceAbs: 4 },
      missingLegTokenId: "down-token",
      price: 0.35,
      placedSize: 1,
      orderId: null,
    });

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).not.toHaveBeenCalled();
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("re-arms recovery path but skips placement when residual is below minimum order size", async () => {
    const { bot, tempDir } = await createBotHarness();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 31);
    bot.tradingEngine.getTopOfBookForCondition = vi.fn(async () => ({
      bestBid: 0.349,
      bestAsk: 0.351,
      topBids: [0.349, 0.348],
      topAsks: [0.351, 0.352],
      rawTopBids: [0.349, 0.348],
      rawTopAsks: [0.351, 0.352],
    }));
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }])
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }]);

    bot.recentRecoveryPlacements.set("cond-1", {
      placedAtMs: 1_000_000,
      summary: { upSize: 4, downSize: 0, differenceAbs: 4 },
      missingLegTokenId: "down-token",
      price: 0.35,
      placedSize: 1,
      orderId: null,
    });

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not cancel and replace when equivalent open recovery order already exists", async () => {
    const { bot, tempDir } = await createBotHarness();
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);
    bot.tradingEngine.hasOpenBuyOrderAtPrice = vi.fn(async () => true);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }])
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }]);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).not.toHaveBeenCalled();
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips reorder when pending open buy exposure already covers missing leg", async () => {
    const { bot, tempDir } = await createBotHarness();
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }])
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }]);
    bot.tradingEngine.getOpenBuyExposure = vi.fn(async () => 4);

    bot.recentRecoveryPlacements.set("cond-1", {
      placedAtMs: Date.now(),
      summary: { upSize: 4, downSize: 0, differenceAbs: 4 },
      missingLegTokenId: "down-token",
      price: 0.35,
      placedSize: 4,
      orderId: "order-1",
    });

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).not.toHaveBeenCalled();
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips residual placement when post-coverage size is below minimum order size", async () => {
    const { bot, tempDir } = await createBotHarness();
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }])
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }]);
    bot.tradingEngine.getOpenBuyExposure = vi.fn(async () => 3);

    bot.recentRecoveryPlacements.set("cond-1", {
      placedAtMs: Date.now(),
      summary: { upSize: 4, downSize: 0, differenceAbs: 4 },
      missingLegTokenId: "down-token",
      price: 0.35,
      placedSize: 3,
      orderId: "order-1",
    });

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips placement when continuous repricing is disabled", async () => {
    const { bot, tempDir } = await createBotHarness({ entryContinuousRepriceEnabled: false });
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);
    bot.dataClient.getPositions = vi.fn().mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }]);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).not.toHaveBeenCalled();
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("switches to force-window hedge flow and balances when profitable", async () => {
    const { bot, tempDir } = await createBotHarness();
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 10);
    bot.dataClient.getPositions = vi.fn().mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }]);
    bot.tradingEngine.getBestAskPriceForCondition = vi.fn(async () => 0.5);
    bot.tradingEngine.completeMissingLegForHedge = vi.fn(async () => ({ tokenId: "down-token", amount: 4, result: { ok: true } }));
    bot.tradingEngine.reconcilePairedEntry = vi.fn(async () => ({
      status: "balanced",
      attempts: 1,
      finalSummary: { upSize: 5, downSize: 5, differenceAbs: 0 },
    }));

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalled();
      expect(bot.tradingEngine.completeMissingLegForHedge).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.reconcilePairedEntry).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("force-window skips hedge when not profitable", async () => {
    const { bot, tempDir } = await createBotHarness();
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 10);
    bot.dataClient.getPositions = vi.fn().mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }]);
    bot.tradingEngine.getBestAskPriceForCondition = vi.fn(async () => 0.7);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.completeMissingLegForHedge).not.toHaveBeenCalled();
      expect(bot.tradingEngine.reconcilePairedEntry).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
