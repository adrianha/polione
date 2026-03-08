import { describe, expect, it } from "vitest";
import { TradingEngine } from "../src/services/tradingEngine.js";
import type { BotConfig, PositionRecord, TokenIds } from "../src/types/domain.js";

const baseConfig: BotConfig = {
  dryRun: true,
  privateKey: `0x${"1".repeat(64)}`,
  signatureType: 0,
  chainId: 137,
  clobApiHost: "https://clob.polymarket.com",
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

  it("flattens imbalanced exposure and returns flattened status", async () => {
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

    expect(result.status).toBe("flattened");
    expect(result.cancelledOpenOrders).toBeDefined();
    expect(sold).toEqual([{ tokenId: "up-token", amount: 5 }]);
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

  it("returns imbalanced when flatten is disabled", async () => {
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
      flattenOnImbalance: false,
    });

    expect(result.status).toBe("imbalanced");
    expect(sold).toEqual([]);
  });

  it("computes repriced entry levels with max cap", () => {
    const clobClient = {
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [],
      placeMarketOrder: async (_params: unknown) => ({ ok: true }),
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };
    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => [],
    };

    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);
    expect(engine.getEntryPriceForAttempt(0)).toBe(0.46);
    expect(engine.getEntryPriceForAttempt(1)).toBe(0.47);
    expect(engine.getEntryPriceForAttempt(9)).toBe(0.5);
  });

  it("rejects liquidity when spread is wider than gate", async () => {
    const clobClient = {
      getOrderBook: async (_tokenId: string) => ({
        bids: [{ price: "0.40", size: "100" }],
        asks: [{ price: "0.50", size: "100" }],
      }),
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [],
      placeMarketOrder: async (_params: unknown) => ({ ok: true }),
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };
    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => [],
    };
    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);

    const result = await engine.evaluateLiquidityForEntry(tokenIds, 0.46);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Spread too wide");
  });

  it("does not reject solely on invalid top spread sentinel", async () => {
    const clobClient = {
      getOrderBook: async (_tokenId: string) => ({
        bids: [],
        asks: [{ price: "0.45", size: "10" }],
      }),
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [],
      placeMarketOrder: async (_params: unknown) => ({ ok: true }),
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };
    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => [],
    };
    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);

    const result = await engine.evaluateLiquidityForEntry(tokenIds, 0.45);
    expect(result.allowed).toBe(true);
    expect(result.orderSize).toBe(5);
  });

  it("adapts order size from depth and usage ratio", async () => {
    const clobClient = {
      getOrderBook: async (tokenId: string) => {
        if (tokenId === "up-token") {
          return {
            bids: [{ price: "0.45", size: "100" }],
            asks: [
              { price: "0.46", size: "4" },
              { price: "0.47", size: "4" },
              { price: "0.49", size: "100" },
            ],
          };
        }
        return {
          bids: [{ price: "0.45", size: "100" }],
          asks: [
            { price: "0.46", size: "8" },
            { price: "0.47", size: "8" },
          ],
        };
      },
      cancelOpenOrdersForTokenIds: async (_ids: string[]) => [],
      placeMarketOrder: async (_params: unknown) => ({ ok: true }),
      placeLimitOrdersBatch: async (_params: unknown) => [],
    };
    const dataClient = {
      getPositions: async (_addr: string, _conditionId?: string): Promise<PositionRecord[]> => [],
    };
    const engine = new TradingEngine(baseConfig, clobClient as never, dataClient as never);

    const result = await engine.evaluateLiquidityForEntry(tokenIds, 0.46);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("ORDER_SIZE");
    expect(result.orderSize).toBe(4.8);
  });
});
