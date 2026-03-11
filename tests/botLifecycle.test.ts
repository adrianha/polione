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
  positionRecheckSeconds: 60,
  entryReconcileSeconds: 1,
  entryReconcilePollSeconds: 1,
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
  entryContinuousRepriceIntervalMs: 10,
  entryContinuousMinPriceDelta: 0.002,
  entryContinuousMaxDurationSeconds: 45,
  entryContinuousMakerOffset: 0.001,
  requestTimeoutMs: 30000,
  requestRetries: 0,
  requestRetryBackoffMs: 0,
  stateFilePath: ".bot-state.test.json",
  logLevel: "info",
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const market: MarketRecord = {
  slug: "btc-updown-5m-test",
  conditionId: "cond-1",
};

const createBot = async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pm-bot-lifecycle-"));
  const bot = new PolymarketBot(
    {
      ...baseConfig,
      stateFilePath: path.join(tempDir, "state.json"),
    },
    logger,
  ) as any;

  bot.marketDiscovery = {
    getTokenIds: vi.fn(() => ({ upTokenId: "up-token", downTokenId: "down-token" })),
    getConditionId: vi.fn(() => "cond-1"),
    getSecondsToMarketClose: vi.fn(() => 120),
  };
  bot.clobWsClient = { ensureSubscribed: vi.fn() };
  bot.clobClient = { getUsdcBalance: vi.fn(async () => 100) };
  bot.dataClient = { getPositions: vi.fn(async () => []) };
  bot.tradingEngine = {
    getEntryPriceForAttempt: vi.fn((attempt: number) => 0.46 + attempt * 0.01),
    placePairedLimitBuysAtPrice: vi.fn(async () => ({ ok: true })),
    placeSingleLimitBuyAtPrice: vi.fn(async () => ({ ok: true })),
    evaluateLiquidityForEntry: vi.fn(async () => ({
      allowed: true,
      orderSize: 5,
      reason: undefined,
      upSpread: 0.01,
      downSpread: 0.01,
      upDepth: 10,
      downDepth: 10,
    })),
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
    getBestAskPrice: vi.fn(async () => 0.4),
    cancelEntryOpenOrders: vi.fn(async () => []),
    completeMissingLegForHedge: vi.fn(async () => ({ ok: true })),
  };
  bot.relayerClient = { isAvailable: vi.fn(() => false) };
  bot.settlementService = { mergeEqualPositions: vi.fn(async () => ({ ok: true })) };
  bot.notify = vi.fn(async () => undefined);
  bot.notifyPlacementSuccessOnce = vi.fn(async () => undefined);

  return { bot, tempDir };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bot lifecycle", () => {
  it("tracks next-market entries immediately without reconciling them", async () => {
    const { bot, tempDir } = await createBot();

    try {
      const sleepSeconds = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "different-current",
        positionsAddress: "0xabc",
      });

      expect(sleepSeconds).toBe(baseConfig.loopSleepSeconds);
      expect(bot.tradingEngine.placePairedLimitBuysAtPrice).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.reconcilePairedEntry).not.toHaveBeenCalled();
      expect(bot.trackedMarkets.has("cond-1")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs continuous recovery for one-sided current-market imbalance outside force window", async () => {
    const { bot, tempDir } = await createBot();
    bot.notifyEntryFilledOnce = vi.fn(async () => undefined);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }])
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 4 }])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 4 },
        { asset: "down-token", conditionId: "cond-1", size: 4 },
      ]);
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.getTopOfBook).toHaveBeenCalled();
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalled();
      expect(bot.notifyEntryFilledOnce).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cancels residual entry orders once when tracked market is balanced", async () => {
    const { bot, tempDir } = await createBot();
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 5 },
      ])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 5 },
      ]);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs balanced cleanup again after imbalance reappears", async () => {
    const { bot, tempDir } = await createBot();
    bot.marketDiscovery.getSecondsToMarketClose = vi
      .fn()
      .mockReturnValueOnce(120)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(120);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 5 },
      ])
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 5 }])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 5 },
      ]);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retries balanced cleanup when cancel fails", async () => {
    const { bot, tempDir } = await createBot();
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 5 },
      ])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 5 },
      ]);
    bot.tradingEngine.cancelEntryOpenOrders = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary cancel error"))
      .mockResolvedValueOnce([]);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("still reconciles immediate entries for current markets", async () => {
    const { bot, tempDir } = await createBot();

    try {
      bot.notifyEntryFilledOnce = vi.fn(async () => undefined);
      const sleepSeconds = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(sleepSeconds).toBe(baseConfig.positionRecheckSeconds);
      expect(bot.tradingEngine.reconcilePairedEntry).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalled();
      expect(bot.notifyEntryFilledOnce).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not run continuous missing-leg recovery during entry processing", async () => {
    const { bot, tempDir } = await createBot();
    bot.notifyEntryFilledOnce = vi.fn(async () => undefined);
    bot.tradingEngine.reconcilePairedEntry = vi.fn(async () => ({
      status: "imbalanced",
      attempts: 1,
      finalSummary: { upSize: 5, downSize: 0, differenceAbs: 5 },
    }));
    try {
      const sleepSeconds = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(sleepSeconds).toBe(baseConfig.loopSleepSeconds);
      expect(bot.tradingEngine.getFilledAveragePriceForOrder).not.toHaveBeenCalled();
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
      expect(bot.tradingEngine.cancelEntryOpenOrders).not.toHaveBeenCalled();
      expect(bot.notifyEntryFilledOnce).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not buy residual imbalance amount during entry processing", async () => {
    const { bot, tempDir } = await createBot();
    bot.notifyEntryFilledOnce = vi.fn(async () => undefined);
    bot.tradingEngine.reconcilePairedEntry = vi.fn(async () => ({
      status: "imbalanced",
      attempts: 1,
      finalSummary: { upSize: 5, downSize: 3, differenceAbs: 2 },
    }));
    try {
      const sleepSeconds = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(sleepSeconds).toBe(baseConfig.loopSleepSeconds);
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
      expect(bot.tradingEngine.cancelEntryOpenOrders).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("entry residual below precision threshold does not place extra order", async () => {
    const { bot, tempDir } = await createBot();
    bot.notifyEntryFilledOnce = vi.fn(async () => undefined);
    bot.tradingEngine.reconcilePairedEntry = vi.fn(async () => ({
      status: "imbalanced",
      attempts: 1,
      finalSummary: { upSize: 5.0000004, downSize: 5, differenceAbs: 0.0000004 },
    }));

    try {
      const sleepSeconds = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(sleepSeconds).toBe(baseConfig.loopSleepSeconds);
      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recovery buys only residual imbalance amount", async () => {
    const { bot, tempDir } = await createBot();
    bot.notifyEntryFilledOnce = vi.fn(async () => undefined);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 4 },
        { asset: "down-token", conditionId: "cond-1", size: 2 },
      ])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 4 },
        { asset: "down-token", conditionId: "cond-1", size: 2 },
      ])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 4 },
        { asset: "down-token", conditionId: "cond-1", size: 4 },
      ]);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).toHaveBeenCalledWith("down-token", expect.any(Number), 2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not place another paired entry after imbalanced current-market reconcile", async () => {
    const { bot, tempDir } = await createBot();
    bot.tradingEngine.reconcilePairedEntry = vi.fn(async () => ({
      status: "imbalanced",
      attempts: 1,
      finalSummary: { upSize: 5, downSize: 0, differenceAbs: 5 },
    }));
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 5 }]);

    try {
      const first = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });
      const second = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      const placedAfterFirstCall = (bot.tradingEngine.placePairedLimitBuysAtPrice as ReturnType<typeof vi.fn>).mock
        .calls.length;

      expect(first).toBe(baseConfig.loopSleepSeconds);
      expect(second).toBe(baseConfig.loopSleepSeconds);
      expect(placedAfterFirstCall).toBeGreaterThan(0);
      expect(bot.tradingEngine.placePairedLimitBuysAtPrice).toHaveBeenCalledTimes(placedAfterFirstCall);
      expect(bot.tradingEngine.reconcilePairedEntry).toHaveBeenCalledTimes(placedAfterFirstCall);
      expect(bot.trackedMarkets.has("cond-1")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips paired entry and tracks market when exposure already exists", async () => {
    const { bot, tempDir } = await createBot();
    bot.dataClient.getPositions = vi.fn(async () => [{ asset: "up-token", conditionId: "cond-1", size: 1 }]);

    try {
      const sleepSeconds = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(sleepSeconds).toBe(baseConfig.loopSleepSeconds);
      expect(bot.tradingEngine.placePairedLimitBuysAtPrice).not.toHaveBeenCalled();
      expect(bot.tradingEngine.reconcilePairedEntry).not.toHaveBeenCalled();
      expect(bot.trackedMarkets.has("cond-1")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not place missing-leg recovery buy when one leg is at strict cap", async () => {
    const { bot, tempDir } = await createBot();
    bot.dataClient.getPositions = vi.fn(async () => [{ asset: "up-token", conditionId: "cond-1", size: 5 }]);
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).not.toHaveBeenCalled();
      expect(bot.tradingEngine.cancelEntryOpenOrders).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips force-window hedge buy when strict cap is already reached", async () => {
    const { bot, tempDir } = await createBot();
    bot.dataClient.getPositions = vi.fn(async () => [{ asset: "down-token", conditionId: "cond-1", size: 5 }]);
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 10);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.completeMissingLegForHedge).not.toHaveBeenCalled();
      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reprices current-market paired entry after imbalanced reconcile", async () => {
    const { bot, tempDir } = await createBot();
    bot.dataClient.getPositions = vi.fn(async () => []);
    bot.tradingEngine.reconcilePairedEntry = vi
      .fn()
      .mockResolvedValueOnce({
        status: "imbalanced",
        attempts: 1,
        finalSummary: { upSize: 5, downSize: 3, differenceAbs: 2 },
        reason: "partial fills",
      })
      .mockResolvedValueOnce({
        status: "balanced",
        attempts: 1,
        finalSummary: { upSize: 5, downSize: 5, differenceAbs: 0 },
      });

    try {
      const sleepSeconds = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(sleepSeconds).toBe(baseConfig.positionRecheckSeconds);
      expect(bot.tradingEngine.placePairedLimitBuysAtPrice).toHaveBeenCalledTimes(2);
      expect(bot.tradingEngine.placePairedLimitBuysAtPrice).toHaveBeenNthCalledWith(
        1,
        { upTokenId: "up-token", downTokenId: "down-token" },
        0.46,
        5,
      );
      const secondCallArgs = (bot.tradingEngine.placePairedLimitBuysAtPrice as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(secondCallArgs?.[0]).toEqual({ upTokenId: "up-token", downTokenId: "down-token" });
      expect(secondCallArgs?.[1]).toBeCloseTo(0.47, 10);
      expect(secondCallArgs?.[2]).toBe(5);
      expect(bot.tradingEngine.reconcilePairedEntry).toHaveBeenCalledTimes(2);
      expect(bot.tradingEngine.cancelEntryOpenOrders).toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses single attempt inside force window and does not reprice", async () => {
    const { bot, tempDir } = await createBot();
    bot.dataClient.getPositions = vi.fn(async () => []);
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 10);
    bot.tradingEngine.reconcilePairedEntry = vi.fn(async () => ({
      status: "balanced",
      attempts: 1,
      finalSummary: { upSize: 5, downSize: 5, differenceAbs: 0 },
    }));

    try {
      const sleepSeconds = await bot.processEntryMarket({
        entryMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(sleepSeconds).toBe(baseConfig.positionRecheckSeconds);
      expect(bot.tradingEngine.placePairedLimitBuysAtPrice).toHaveBeenCalledTimes(1);
      expect(bot.tradingEngine.placePairedLimitBuysAtPrice).toHaveBeenCalledWith(
        { upTokenId: "up-token", downTokenId: "down-token" },
        0.46,
        5,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips missing-leg reorder when computed recovery price is unchanged", async () => {
    const { bot, tempDir } = await createBot();
    bot.dataClient.getPositions = vi.fn(async () => [{ asset: "up-token", conditionId: "cond-1", size: 4 }]);
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);
    bot.tradingEngine.getTopOfBook = vi.fn(async () => ({ bestBid: 0.349, bestAsk: 0.351 }));

    bot.recentRecoveryPlacements.set("cond-1", {
      placedAtMs: Date.now(),
      summary: { upSize: 4, downSize: 0, differenceAbs: 4 },
      missingLegTokenId: "down-token",
      price: 0.35,
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
});
