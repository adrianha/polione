import type { DataClient } from "../clients/dataClient.js";
import type { BotConfig, EntryReconcileResult, TokenIds } from "../types/domain.js";
import type { PolyClobClient } from "../clients/clobClient.js";
import { OrderType, type OrderBookSummary } from "@polymarket/clob-client";
import { arePositionsEqual, summarizePositions } from "./positionManager.js";
import { sleep } from "../utils/time.js";

export class MarketTokenMismatchError extends Error {
  readonly conditionId: string;
  readonly tokenId: string;

  constructor(params: { conditionId: string; tokenId: string }) {
    super(`Token ${params.tokenId} does not belong to condition ${params.conditionId}`);
    this.name = "MarketTokenMismatchError";
    this.conditionId = params.conditionId;
    this.tokenId = params.tokenId;
  }
}

export class TradingEngine {
  constructor(
    private readonly config: BotConfig,
    private readonly clobClient: PolyClobClient,
    private readonly dataClient: DataClient,
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

  private parsePositive(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }
    return parsed;
  }

  private validateTokenId(tokenId: string): string {
    const normalized = tokenId.trim();
    if (!normalized) {
      throw new Error("Token id is required");
    }

    return normalized;
  }

  private getBestAsk(book: OrderBookSummary): number {
    const ask = this.parsePositive(book.asks?.[0]?.price);
    return ask > 0 ? ask : Number.POSITIVE_INFINITY;
  }

  private assertTokenInConditionContext(params: { conditionId: string; tokenId: string; tokenIds: TokenIds }): void {
    if (params.tokenId === params.tokenIds.upTokenId || params.tokenId === params.tokenIds.downTokenId) {
      return;
    }

    throw new MarketTokenMismatchError({
      conditionId: params.conditionId,
      tokenId: params.tokenId,
    });
  }

  async getBestAskPrice(tokenId: string): Promise<number> {
    const validatedTokenId = this.validateTokenId(tokenId);
    const book = await this.clobClient.getOrderBook(validatedTokenId);
    return this.getBestAsk(book);
  }

  async getBestAskPriceForCondition(params: {
    conditionId: string;
    tokenIds: TokenIds;
    tokenId: string;
  }): Promise<number> {
    this.assertTokenInConditionContext(params);
    return this.getBestAskPrice(params.tokenId);
  }

  async getBestBidAskSnapshot(tokenId: string): Promise<{
    bestBid: number;
    bestAsk: number;
    topBids: number[];
    topAsks: number[];
    rawTopBids: number[];
    rawTopAsks: number[];
    priceSource: "sdk";
    sdkBestBid: number;
    sdkBestAsk: number;
  }> {
    const validatedTokenId = this.validateTokenId(tokenId);
    const [sdkBestBidRaw, sdkBestAskRaw] = await Promise.all([
      this.clobClient.getBestBookPriceForSide(validatedTokenId, "SELL").catch(() => 0),
      this.clobClient.getBestBookPriceForSide(validatedTokenId, "BUY").catch(() => 0),
    ]);
    const sdkBestBid = this.parsePositive(sdkBestBidRaw);
    const sdkBestAsk = this.parsePositive(sdkBestAskRaw);
    const bestBid = sdkBestBid;
    const bestAsk = sdkBestAsk;
    const topBids = sdkBestBid > 0 ? [sdkBestBid] : [];
    const topAsks = sdkBestAsk > 0 ? [sdkBestAsk] : [];
    const rawTopBids = [...topBids];
    const rawTopAsks = [...topAsks];
    return {
      bestBid,
      bestAsk,
      topBids,
      topAsks,
      rawTopBids,
      rawTopAsks,
      priceSource: "sdk",
      sdkBestBid,
      sdkBestAsk,
    };
  }

  async getBestBidAskSnapshotForCondition(params: {
    conditionId: string;
    tokenIds: TokenIds;
    tokenId: string;
  }): Promise<{
    bestBid: number;
    bestAsk: number;
    topBids: number[];
    topAsks: number[];
    rawTopBids: number[];
    rawTopAsks: number[];
    priceSource: "sdk";
    sdkBestBid: number;
    sdkBestAsk: number;
  }> {
    const validatedTokenId = this.validateTokenId(params.tokenId);
    this.assertTokenInConditionContext({
      conditionId: params.conditionId,
      tokenIds: params.tokenIds,
      tokenId: validatedTokenId,
    });
    return this.getBestBidAskSnapshot(validatedTokenId);
  }

  async hasOpenBuyOrderAtPrice(tokenId: string, price: number): Promise<boolean> {
    const targetPrice = this.parsePositive(price);
    if (targetPrice <= 0) {
      return false;
    }

    const openOrders = await this.clobClient.getOpenOrders();
    const records = Array.isArray(openOrders) ? openOrders : [];
    const epsilon = 1e-6;

    return records.some((record) => {
      const tokenIdValue =
        (record as { tokenID?: unknown }).tokenID ??
        (record as { tokenId?: unknown }).tokenId ??
        (record as { asset_id?: unknown }).asset_id ??
        (record as { assetId?: unknown }).assetId;
      if (tokenIdValue !== tokenId) {
        return false;
      }

      const sideValue =
        (record as { side?: unknown }).side ??
        (record as { orderSide?: unknown }).orderSide ??
        (record as { order_side?: unknown }).order_side;
      const side = typeof sideValue === "string" ? sideValue.toUpperCase() : "";
      if (side !== "BUY") {
        return false;
      }

      const orderPrice = this.parsePositive(
        (record as { price?: unknown }).price ??
          (record as { limitPrice?: unknown }).limitPrice ??
          (record as { limit_price?: unknown }).limit_price,
      );

      return orderPrice > 0 && Math.abs(orderPrice - targetPrice) < epsilon;
    });
  }

  async getOpenBuyExposure(tokenId: string): Promise<number> {
    const openOrders = await this.clobClient.getOpenOrders();
    const records = Array.isArray(openOrders) ? openOrders : [];

    const total = records.reduce((sum, record) => {
      const tokenIdValue =
        (record as { tokenID?: unknown }).tokenID ??
        (record as { tokenId?: unknown }).tokenId ??
        (record as { asset_id?: unknown }).asset_id ??
        (record as { assetId?: unknown }).assetId;
      if (tokenIdValue !== tokenId) {
        return sum;
      }

      const sideValue =
        (record as { side?: unknown }).side ??
        (record as { orderSide?: unknown }).orderSide ??
        (record as { order_side?: unknown }).order_side;
      const side = typeof sideValue === "string" ? sideValue.toUpperCase() : "";
      if (side !== "BUY") {
        return sum;
      }

      const size = this.parsePositive(
        (record as { remainingSize?: unknown }).remainingSize ??
          (record as { size_remaining?: unknown }).size_remaining ??
          (record as { unfilled_size?: unknown }).unfilled_size ??
          (record as { size?: unknown }).size,
      );
      const matched = this.parsePositive(
        (record as { sizeMatched?: unknown }).sizeMatched ??
          (record as { size_matched?: unknown }).size_matched ??
          (record as { filledSize?: unknown }).filledSize,
      );

      const remaining = size > 0 ? Math.max(0, size - matched) : 0;
      const contribution = remaining > 0 ? remaining : size;
      return sum + contribution;
    }, 0);

    return Number(total.toFixed(6));
  }

  async getOrderFillState(orderId: string): Promise<{
    matchedSize: number;
    remainingSize: number;
    isOpen: boolean;
    status: string | null;
  } | null> {
    let orderPayload: unknown;
    try {
      orderPayload = await this.clobClient.getOrder(orderId);
    } catch {
      return null;
    }

    if (!orderPayload || typeof orderPayload !== "object") {
      return null;
    }

    const orderRecord = orderPayload as Record<string, unknown>;
    const size = this.parsePositive(
      orderRecord.size ?? orderRecord.original_size ?? orderRecord.initial_size ?? orderRecord.amount,
    );
    const matchedSize = this.parsePositive(
      orderRecord.size_matched ?? orderRecord.sizeMatched ?? orderRecord.filled_size ?? orderRecord.filledSize,
    );
    const statusRaw = orderRecord.status;
    const status = typeof statusRaw === "string" ? statusRaw.toLowerCase() : null;
    const explicitlyOpen = status === "live" || status === "open" || status === "pending";
    const remainingSize = Math.max(0, Number((size - matchedSize).toFixed(6)));
    const isOpen = explicitlyOpen || remainingSize > 0;

    return {
      matchedSize: Number(matchedSize.toFixed(6)),
      remainingSize,
      isOpen,
      status,
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
      orderType: OrderType.FOK,
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
