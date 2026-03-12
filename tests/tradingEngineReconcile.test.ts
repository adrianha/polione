import { describe, expect, it } from "vitest";
import { TradingEngine } from "../src/services/tradingEngine.js";
import type { BotConfig, PositionRecord, TokenIds } from "../src/types/domain.js";

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

const tokenIds: TokenIds = {
  upTokenId: "up-token",
  downTokenId: "down-token",
};

describe("trading engine entry reconciliation", () => {
  it("returns balanced when positions are equal", async () => {
    const clobClient = {
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [],
      placeMarketOrder: async (_params: unknown) => ({ ok: true }),
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };

    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => {
        return [
          { asset: "up-token", conditionId: "cond", size: 5 },
          { asset: "down-token", conditionId: "cond", size: 5 },
        ];
      },
    };

    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);
    const result = await engine.reconcilePairedEntry({
      positionsAddress: "0xabc",
      conditionId: "cond",
      tokenIds,
    });

    expect(result.status).toBe("balanced");
    expect(result.finalSummary.upSize).toBe(5);
    expect(result.finalSummary.downSize).toBe(5);
  });

  it("returns imbalanced when only one leg fills", async () => {
    const sold: Array<{ tokenId: string; amount: number }> = [];
    const clobClient = {
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [{ cancelled: 1 }],
      placeMarketOrder: async (params: { tokenId: string; amount: number }) => {
        sold.push({ tokenId: params.tokenId, amount: params.amount });
        return { dryRun: true };
      },
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };

    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => {
        return [{ asset: "up-token", conditionId: "cond", size: 5 }];
      },
    };

    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);
    const result = await engine.reconcilePairedEntry({
      positionsAddress: "0xabc",
      conditionId: "cond",
      tokenIds,
    });

    expect(result.status).toBe("imbalanced");
    expect(result.cancelledOpenOrders).toBeDefined();
    expect(sold).toEqual([]);
  });

  it("fails reconciliation when no leg fills", async () => {
    const sold: Array<{ tokenId: string; amount: number }> = [];
    const clobClient = {
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [{ cancelled: 1 }],
      placeMarketOrder: async (params: { tokenId: string; amount: number }) => {
        sold.push({ tokenId: params.tokenId, amount: params.amount });
        return { dryRun: true };
      },
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };

    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => {
        return [];
      },
    };

    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);
    const result = await engine.reconcilePairedEntry({
      positionsAddress: "0xabc",
      conditionId: "cond",
      tokenIds,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("No fills detected");
    expect(sold).toEqual([]);
  });

  it("returns imbalanced with no flatten branch", async () => {
    const sold: Array<{ tokenId: string; amount: number }> = [];
    const clobClient = {
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [{ cancelled: 1 }],
      placeMarketOrder: async (params: { tokenId: string; amount: number }) => {
        sold.push({ tokenId: params.tokenId, amount: params.amount });
        return { dryRun: true };
      },
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };

    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => {
        return [{ asset: "up-token", conditionId: "cond", size: 5 }];
      },
    };

    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);
    const result = await engine.reconcilePairedEntry({
      positionsAddress: "0xabc",
      conditionId: "cond",
      tokenIds,
    });

    expect(result.status).toBe("imbalanced");
    expect(sold).toEqual([]);
  });

  it("computes filled average price from associated trades", async () => {
    const clobClient = {
      getOrder: async (_orderId: string) => ({
        id: "order-1",
        associate_trades: ["trade-1", "trade-2"],
      }),
      getTrades: async (params?: { id?: string }) => {
        if (params?.id === "trade-1") {
          return [{ id: "trade-1", price: "0.37", size: "2" }];
        }
        if (params?.id === "trade-2") {
          return [{ id: "trade-2", price: "0.39", size: "3" }];
        }
        return [];
      },
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [],
      placeMarketOrder: async (_params: unknown) => ({ ok: true }),
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };
    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => [],
    };
    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);

    const result = await engine.getFilledAveragePriceForOrder({ orderID: "order-1" }, 0.46);
    expect(result.avgPrice).toBe(0.382);
    expect(result.filledSize).toBe(5);
    expect(result.source).toBe("trades");
    expect(result.orderId).toBe("order-1");
  });

  it("falls back to entry price when order id is missing", async () => {
    const clobClient = {
      getOrder: async (_orderId: string) => ({ id: "order-1" }),
      getTrades: async (_params?: { id?: string }) => [],
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [],
      placeMarketOrder: async (_params: unknown) => ({ ok: true }),
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };
    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => [],
    };
    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);

    const result = await engine.getFilledAveragePriceForOrder({ dryRun: true }, 0.46);
    expect(result.avgPrice).toBe(0.46);
    expect(result.filledSize).toBe(0);
    expect(result.source).toBe("fallback");
    expect(result.orderId).toBeNull();
  });
});
