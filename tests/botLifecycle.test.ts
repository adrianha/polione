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

  it("runs single-step recovery for one-sided current-market imbalance outside force window", async () => {
    const { bot, tempDir } = await createBot();
    bot.notifyEntryFilledOnce = vi.fn(async () => undefined);
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 5 }])
      .mockResolvedValueOnce([{ asset: "up-token", conditionId: "cond-1", size: 5 }])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 5 },
      ]);
    bot.marketDiscovery.getSecondsToMarketClose = vi.fn(() => 120);

    try {
      await bot.processTrackedCurrentMarket({
        currentMarket: market,
        currentConditionId: "cond-1",
        positionsAddress: "0xabc",
      });

      expect(bot.tradingEngine.getTopOfBook).toHaveBeenCalled();
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

  it("defers one-leg entry imbalance handling to tracked-market flow", async () => {
    const { bot, tempDir } = await createBot();
    bot.notifyEntryFilledOnce = vi.fn(async () => undefined);
    bot.tradingEngine.reconcilePairedEntry = vi.fn(async () => ({
      status: "imbalanced",
      attempts: 1,
      finalSummary: { upSize: 5, downSize: 3, differenceAbs: 2 },
    }));
    bot.dataClient.getPositions = vi
      .fn()
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 3 },
      ])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 5 },
      ]);

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
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 3 },
      ])
      .mockResolvedValueOnce([
        { asset: "up-token", conditionId: "cond-1", size: 5 },
        { asset: "down-token", conditionId: "cond-1", size: 3 },
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

      expect(bot.tradingEngine.placeSingleLimitBuyAtPrice).toHaveBeenCalledWith("down-token", expect.any(Number), 2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
