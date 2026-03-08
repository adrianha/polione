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
  positionRecheckSeconds: 60,
  entryReconcileSeconds: 1,
  entryReconcilePollSeconds: 1,
  entryCancelOpenOrders: true,
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
});
