import type { DataClient } from "../clients/dataClient.js";
import type { BotConfig, EntryReconcileResult, TokenIds } from "../types/domain.js";
import type { PolyClobClient } from "../clients/clobClient.js";
import type { ClobWsClient } from "../clients/clobWsClient.js";
import { OrderType, type OrderBookSummary } from "@polymarket/clob-client";
import { arePositionsEqual, summarizePositions } from "./positionManager.js";
import { sleep } from "../utils/time.js";

export class TradingEngine {
  constructor(
    private readonly config: BotConfig,
    private readonly clobClient: PolyClobClient,
    private readonly dataClient: DataClient,
    private readonly clobWsClient?: ClobWsClient,
  ) {}

  async placePairedLimitBuys(tokenIds: TokenIds): Promise<{ up: unknown; down: unknown }> {
    return this.placePairedLimitBuysAtPrice(tokenIds, this.config.orderPrice, this.config.orderSize);
  }

  async placePairedLimitBuysAtPrice(
    tokenIds: TokenIds,
    price: number,
    size: number,
  ): Promise<{ up: unknown; down: unknown }> {
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

  async placeSingleLimitBuyAtPrice(tokenId: string, price: number, size: number): Promise<unknown> {
    return this.clobClient.placeLimitOrder({
      tokenId,
      side: "BUY",
      price,
      size,
    });
  }

  extractOrderId(orderResult: unknown): string | null {
    if (!orderResult || typeof orderResult !== "object") {
      return null;
    }

    const record = orderResult as Record<string, unknown>;
    const candidates = [record.orderID, record.orderId, record.order_id, record.id];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }

    return null;
  }

  async getFilledAveragePriceForOrder(
    orderResult: unknown,
    fallbackPrice: number,
  ): Promise<{
    avgPrice: number;
    filledSize: number;
    source: "trades" | "order" | "fallback";
    orderId: string | null;
  }> {
    const orderId = this.extractOrderId(orderResult);
    const fallback = {
      avgPrice: fallbackPrice,
      filledSize: 0,
      source: "fallback" as const,
      orderId,
    };

    if (!orderId) {
      return fallback;
    }

    let orderPayload: unknown;
    try {
      orderPayload = await this.clobClient.getOrder(orderId);
    } catch {
      return fallback;
    }

    if (!orderPayload || typeof orderPayload !== "object") {
      return fallback;
    }

    const orderRecord = orderPayload as Record<string, unknown>;
    const associatedTrades = Array.isArray(orderRecord.associate_trades)
      ? orderRecord.associate_trades.filter((item): item is string => typeof item === "string")
      : [];

    let totalSize = 0;
    let totalNotional = 0;

    for (const tradeId of associatedTrades) {
      let trades: unknown[] = [];
      try {
        trades = await this.clobClient.getTrades({ id: tradeId });
      } catch {
        continue;
      }

      const matchedTrade = trades.find((trade) => {
        if (!trade || typeof trade !== "object") {
          return false;
        }
        const tradeIdValue = (trade as Record<string, unknown>).id;
        return typeof tradeIdValue !== "string" || tradeIdValue === tradeId;
      });

      if (!matchedTrade || typeof matchedTrade !== "object") {
        continue;
      }

      const tradeRecord = matchedTrade as Record<string, unknown>;
      const price = this.parsePositive(tradeRecord.price);
      const size = this.parsePositive(tradeRecord.size);
      if (price <= 0 || size <= 0) {
        continue;
      }

      totalSize += size;
      totalNotional += price * size;
    }

    if (totalSize > 0 && totalNotional > 0) {
      return {
        avgPrice: Number((totalNotional / totalSize).toFixed(6)),
        filledSize: Number(totalSize.toFixed(6)),
        source: "trades",
        orderId,
      };
    }

    const matchedSize = this.parsePositive(orderRecord.size_matched);
    const orderPrice = this.parsePositive(orderRecord.price);
    if (matchedSize > 0 && orderPrice > 0) {
      return {
        avgPrice: orderPrice,
        filledSize: matchedSize,
        source: "order",
        orderId,
      };
    }

    return fallback;
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

  async evaluateLiquidityForEntry(
    tokenIds: TokenIds,
    entryPrice: number,
  ): Promise<{
    allowed: boolean;
    orderSize: number;
    reason?: string;
    upSpread?: number;
    downSpread?: number;
    upDepth?: number;
    downDepth?: number;
  }> {
    this.clobWsClient?.ensureSubscribed([tokenIds.upTokenId, tokenIds.downTokenId]);

    const upWs = this.clobWsClient?.getFreshQuote(tokenIds.upTokenId) ?? null;
    const downWs = this.clobWsClient?.getFreshQuote(tokenIds.downTokenId) ?? null;

    if (upWs && downWs) {
      const upSpread = upWs.bestAsk - upWs.bestBid;
      const downSpread = downWs.bestAsk - downWs.bestBid;

      if (upSpread > this.config.entryMaxSpread || downSpread > this.config.entryMaxSpread) {
        return {
          allowed: false,
          orderSize: 0,
          reason: "Spread too wide",
          upSpread,
          downSpread,
        };
      }
    }

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
    this.clobWsClient?.ensureSubscribed([tokenId]);
    const wsQuote = this.clobWsClient?.getFreshQuote(tokenId) ?? null;
    if (wsQuote && wsQuote.bestAsk > 0) {
      return wsQuote.bestAsk;
    }

    const book = await this.clobClient.getOrderBook(tokenId);
    return this.getBestAsk(book);
  }

  async getTopOfBook(tokenId: string): Promise<{ bestBid: number; bestAsk: number }> {
    this.clobWsClient?.ensureSubscribed([tokenId]);
    const wsQuote = this.clobWsClient?.getFreshQuote(tokenId) ?? null;
    if (wsQuote && wsQuote.bestAsk > 0 && wsQuote.bestBid > 0) {
      return {
        bestBid: wsQuote.bestBid,
        bestAsk: wsQuote.bestAsk,
      };
    }

    const book = await this.clobClient.getOrderBook(tokenId);
    const bestBid = this.parsePositive(book.bids?.[0]?.price);
    const bestAsk = this.parsePositive(book.asks?.[0]?.price);
    return {
      bestBid,
      bestAsk,
    };
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
      orderType: OrderType.FAK,
    });

    return {
      tokenId,
      amount,
      result,
    };
  }

  async reconcilePairedEntry(params: {
    positionsAddress: string;
    conditionId: string;
    tokenIds: TokenIds;
    cancelOpenOrders?: boolean;
  }): Promise<EntryReconcileResult> {
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

    reasons.push("Imbalanced exposure remains after entry reconciliation window");
    return {
      status: "imbalanced",
      attempts,
      finalSummary,
      cancelledOpenOrders,
      reason: reasons.join("; "),
    };
  }
}
