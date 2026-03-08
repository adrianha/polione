import type { DataClient } from "../clients/dataClient.js";
import type { BotConfig, EntryReconcileResult, TokenIds } from "../types/domain.js";
import type { PolyClobClient } from "../clients/clobClient.js";
import type { OrderBookSummary } from "@polymarket/clob-client";
import { arePositionsEqual, summarizePositions } from "./positionManager.js";
import { sleep } from "../utils/time.js";

export class TradingEngine {
  constructor(
    private readonly config: BotConfig,
    private readonly clobClient: PolyClobClient,
    private readonly dataClient: DataClient,
  ) {}

  async placePairedLimitBuys(tokenIds: TokenIds): Promise<{ up: unknown; down: unknown }> {
    return this.placePairedLimitBuysAtPrice(tokenIds, this.config.orderPrice, this.config.orderSize);
  }

  async placePairedLimitBuysAtPrice(tokenIds: TokenIds, price: number, size: number): Promise<{ up: unknown; down: unknown }> {
    const batchResult = await this.clobClient.placeLimitOrdersBatch([
      {
        tokenId: tokenIds.upTokenId,
        side: "BUY",
        price,
        size,
      },
      {
        tokenId: tokenIds.downTokenId,
        side: "BUY",
        price,
        size,
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

  private parsePositive(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }
    return parsed;
  }

  private getBestBidAsk(book: OrderBookSummary): { bestBid: number; bestAsk: number; spread: number } {
    const bestBid = this.parsePositive(book.bids?.[0]?.price);
    const bestAsk = this.parsePositive(book.asks?.[0]?.price);
    if (bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) {
      return { bestBid, bestAsk, spread: Number.POSITIVE_INFINITY };
    }
    return { bestBid, bestAsk, spread: bestAsk - bestBid };
  }

  private getAskDepthWithinBand(book: OrderBookSummary, maxPrice: number): number {
    let depth = 0;
    const asks = Array.isArray(book.asks) ? book.asks : [];
    for (const level of asks) {
      const price = this.parsePositive(level.price);
      const size = this.parsePositive(level.size);
      if (price <= 0 || size <= 0) {
        continue;
      }
      if (price > maxPrice) {
        break;
      }
      depth += size;
    }
    return depth;
  }

  private getBestAsk(book: OrderBookSummary): number {
    const ask = this.parsePositive(book.asks?.[0]?.price);
    return ask > 0 ? ask : Number.POSITIVE_INFINITY;
  }

  async evaluateLiquidityForEntry(tokenIds: TokenIds, entryPrice: number): Promise<{
    allowed: boolean;
    orderSize: number;
    reason?: string;
    upSpread?: number;
    downSpread?: number;
    upDepth?: number;
    downDepth?: number;
  }> {
    const [upBook, downBook] = await Promise.all([
      this.clobClient.getOrderBook(tokenIds.upTokenId),
      this.clobClient.getOrderBook(tokenIds.downTokenId),
    ]);

    const upTop = this.getBestBidAsk(upBook);
    const downTop = this.getBestBidAsk(downBook);
    const upInvalidTop = !Number.isFinite(upTop.spread);
    const downInvalidTop = !Number.isFinite(downTop.spread);
    const upTopTooWide = !upInvalidTop && upTop.spread > this.config.entryMaxSpread;
    const downTopTooWide = !downInvalidTop && downTop.spread > this.config.entryMaxSpread;

    if (upTopTooWide || downTopTooWide) {
      return {
        allowed: false,
        orderSize: 0,
        reason: "Spread too wide",
        upSpread: upTop.spread,
        downSpread: downTop.spread,
      };
    }

    const depthMaxPrice = Math.min(1, entryPrice + this.config.entryDepthPriceBand);
    const upDepth = this.getAskDepthWithinBand(upBook, depthMaxPrice);
    const downDepth = this.getAskDepthWithinBand(downBook, depthMaxPrice);

    const maxPairDepth = Math.min(upDepth, downDepth);
    const depthBoundOrderSize = maxPairDepth * this.config.entryDepthUsageRatio;
    const adaptiveOrderSize = Number(Math.min(this.config.orderSize, depthBoundOrderSize).toFixed(4));

    if (adaptiveOrderSize < this.config.orderSize) {
      return {
        allowed: false,
        orderSize: adaptiveOrderSize,
        reason: "Insufficient depth for ORDER_SIZE",
        upSpread: upTop.spread,
        downSpread: downTop.spread,
        upDepth,
        downDepth,
      };
    }

    return {
      allowed: true,
      orderSize: adaptiveOrderSize,
      upSpread: upTop.spread,
      downSpread: downTop.spread,
      upDepth,
      downDepth,
    };
  }

  async getBestAskPrice(tokenId: string): Promise<number> {
    const book = await this.clobClient.getOrderBook(tokenId);
    return this.getBestAsk(book);
  }

  async cancelEntryOpenOrders(tokenIds: TokenIds): Promise<unknown[]> {
    return this.clobClient.cancelOpenOrdersForTokenIds([tokenIds.upTokenId, tokenIds.downTokenId]);
  }

  async completeMissingLegForHedge(
    summary: { upSize: number; downSize: number },
    tokenIds: TokenIds,
    maxBuyPrice: number,
  ): Promise<{ tokenId: string; amount: number; result: unknown } | null> {
    const missingUp = Math.max(0, summary.downSize - summary.upSize);
    const missingDown = Math.max(0, summary.upSize - summary.downSize);

    if (missingUp <= 0 && missingDown <= 0) {
      return null;
    }

    const tokenId = missingUp > 0 ? tokenIds.upTokenId : tokenIds.downTokenId;
    const amount = missingUp > 0 ? missingUp : missingDown;

    const result = await this.clobClient.placeMarketOrder({
      tokenId,
      side: "BUY",
      amount,
      price: maxBuyPrice,
    });

    return {
      tokenId,
      amount,
      result,
    };
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
