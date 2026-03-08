import type { DataClient } from "../clients/dataClient.js";
import type { BotConfig, EntryReconcileResult, TokenIds } from "../types/domain.js";
import type { PolyClobClient } from "../clients/clobClient.js";
import { arePositionsEqual, summarizePositions } from "./positionManager.js";
import { sleep } from "../utils/time.js";

export class TradingEngine {
  constructor(
    private readonly config: BotConfig,
    private readonly clobClient: PolyClobClient,
    private readonly dataClient: DataClient,
  ) {}

  async placePairedLimitBuys(tokenIds: TokenIds): Promise<{ up: unknown; down: unknown }> {
    return this.placePairedLimitBuysAtPrice(tokenIds, this.config.orderPrice);
  }

  async placePairedLimitBuysAtPrice(tokenIds: TokenIds, price: number): Promise<{ up: unknown; down: unknown }> {
    const batchResult = await this.clobClient.placeLimitOrdersBatch([
      {
        tokenId: tokenIds.upTokenId,
        side: "BUY",
        price,
        size: this.config.orderSize,
      },
      {
        tokenId: tokenIds.downTokenId,
        side: "BUY",
        price,
        size: this.config.orderSize,
      },
    ]);

    if (batchResult && typeof batchResult === "object" && "dryRun" in batchResult) {
      const dryRunPayload = batchResult as {
        dryRun: boolean;
        intents?: unknown[];
      };
      return {
        up: dryRunPayload.intents?.[0],
        down: dryRunPayload.intents?.[1],
      };
    }

    const posted = Array.isArray(batchResult) ? batchResult : [];

    return {
      up: posted[0] ?? batchResult,
      down: posted[1] ?? batchResult,
    };
  }

  getEntryPriceForAttempt(attempt: number): number {
    const stepped = this.config.orderPrice + this.config.entryRepriceStep * Math.max(0, attempt);
    return Math.min(this.config.entryMaxPrice, Number(stepped.toFixed(4)));
  }

  async forceSellAll(
    summary: { upSize: number; downSize: number },
    tokenIds: TokenIds,
  ): Promise<{ up?: unknown; down?: unknown }> {
    const results: { up?: unknown; down?: unknown } = {};

    if (summary.upSize > 0) {
      results.up = await this.clobClient.placeMarketOrder({
        tokenId: tokenIds.upTokenId,
        side: "SELL",
        amount: summary.upSize,
        price: 0.01,
      });
    }

    if (summary.downSize > 0) {
      results.down = await this.clobClient.placeMarketOrder({
        tokenId: tokenIds.downTokenId,
        side: "SELL",
        amount: summary.downSize,
        price: 0.01,
      });
    }

    return results;
  }

  async reconcilePairedEntry(params: {
    positionsAddress: string;
    conditionId: string;
    tokenIds: TokenIds;
    flattenOnImbalance?: boolean;
    cancelOpenOrders?: boolean;
  }): Promise<EntryReconcileResult> {
    const flattenOnImbalance = params.flattenOnImbalance ?? true;
    const cancelOpenOrders = params.cancelOpenOrders ?? this.config.entryCancelOpenOrders;
    const attempts = Math.max(
      1,
      Math.ceil(this.config.entryReconcileSeconds / Math.max(1, this.config.entryReconcilePollSeconds)),
    );

    let finalSummary = {
      upSize: 0,
      downSize: 0,
      differenceAbs: 0,
    };

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const positions = await this.dataClient.getPositions(params.positionsAddress, params.conditionId);
      finalSummary = summarizePositions(positions, params.tokenIds);

      const hasBothLegsFilled = finalSummary.upSize > 0 && finalSummary.downSize > 0;
      if (hasBothLegsFilled && arePositionsEqual(finalSummary, this.config.positionEqualityTolerance)) {
        return {
          status: "balanced",
          attempts: attempt,
          finalSummary,
        };
      }

      if (attempt < attempts) {
        await sleep(this.config.entryReconcilePollSeconds);
      }
    }

    const reasons: string[] = [];
    let cancelledOpenOrders: unknown[] | undefined;

    if (cancelOpenOrders) {
      try {
        cancelledOpenOrders = await this.clobClient.cancelOpenOrdersForTokenIds([
          params.tokenIds.upTokenId,
          params.tokenIds.downTokenId,
        ]);
      } catch (error) {
        reasons.push(`Cancel open orders failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (finalSummary.upSize <= 0 && finalSummary.downSize <= 0) {
      reasons.push("No fills detected during entry reconciliation window");
      return {
        status: "failed",
        attempts,
        finalSummary,
        cancelledOpenOrders,
        reason: reasons.join("; "),
      };
    }

    if (!flattenOnImbalance) {
      reasons.push("Imbalanced exposure remains after entry reconciliation window");
      return {
        status: "imbalanced",
        attempts,
        finalSummary,
        cancelledOpenOrders,
        reason: reasons.join("; "),
      };
    }

    try {
      const flattenResult = await this.forceSellAll(finalSummary, params.tokenIds);
      return {
        status: "flattened",
        attempts,
        finalSummary,
        cancelledOpenOrders,
        flattenResult,
        reason: reasons.length > 0 ? reasons.join("; ") : undefined,
      };
    } catch (error) {
      reasons.push(`Flatten failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        status: "failed",
        attempts,
        finalSummary,
        cancelledOpenOrders,
        reason: reasons.join("; "),
      };
    }
  }
}
