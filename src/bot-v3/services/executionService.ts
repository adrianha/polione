import type { Logger } from "pino";
import { PolyClobClient } from "../../clients/clobClient.js";
import type { V3Config, V3OrderExecutionResult } from "../types.js";

const roundBuyPrice = (price: number): number => Number((Math.ceil(price * 100) / 100).toFixed(2));
const roundSellPrice = (price: number): number => Number((Math.floor(price * 100) / 100).toFixed(2));

export class V3ExecutionService {
  constructor(
    private readonly config: V3Config,
    private readonly clobClient: PolyClobClient,
    private readonly logger: Logger,
  ) {}

  async buyToken(params: {
    tokenId: string;
    size: number;
    bestAsk: number;
    maxEntryAsk: number;
  }): Promise<V3OrderExecutionResult> {
    const maxBuyPrice = roundBuyPrice(Math.min(params.bestAsk, params.maxEntryAsk));
    const orderResult = await this.clobClient.placeMarketOrder({
      tokenId: params.tokenId,
      side: "BUY",
      amount: params.size,
      price: maxBuyPrice,
    });

    return this.finalizeOrderExecution(orderResult, maxBuyPrice, params.size);
  }

  async sellToken(params: {
    tokenId: string;
    size: number;
    bestBid: number;
  }): Promise<V3OrderExecutionResult> {
    const limitPrice = roundSellPrice(params.bestBid);
    if (limitPrice <= 0) {
      return { orderId: null, filledSize: 0, averagePrice: 0 };
    }

    const orderResult = await this.clobClient.placeLimitOrder({
      tokenId: params.tokenId,
      side: "SELL",
      price: limitPrice,
      size: params.size,
    });

    return this.finalizeOrderExecution(orderResult, limitPrice, params.size);
  }

  private async finalizeOrderExecution(
    orderResult: unknown,
    submittedPrice: number,
    submittedSize: number,
  ): Promise<V3OrderExecutionResult> {
    if (orderResult && typeof orderResult === "object" && "dryRun" in orderResult) {
      return {
        orderId: null,
        filledSize: submittedSize,
        averagePrice: submittedPrice,
      };
    }

    const orderId = this.extractOrderId(orderResult);
    if (!orderId) {
      this.logger.warn({ orderResult }, "V3 order placed without an order id");
      return {
        orderId: null,
        filledSize: 0,
        averagePrice: submittedPrice,
      };
    }

    const fill = await this.awaitOrderFill(orderId, submittedPrice);
    if (fill.isOpen) {
      try {
        await this.clobClient.cancelOrder(orderId);
      } catch (error) {
        this.logger.warn({ error, orderId }, "Failed to cancel residual V3 order after fill wait");
      }
    }

    return {
      orderId,
      filledSize: fill.filledSize,
      averagePrice: fill.averagePrice,
    };
  }

  private extractOrderId(orderResult: unknown): string | null {
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

  private async awaitOrderFill(
    orderId: string,
    fallbackPrice: number,
  ): Promise<{ filledSize: number; averagePrice: number; isOpen: boolean }> {
    const startedAt = Date.now();
    let latest = {
      filledSize: 0,
      averagePrice: fallbackPrice,
      isOpen: true,
    };

    while (Date.now() - startedAt <= this.config.orderFillTimeoutMs) {
      latest = await this.readOrderFill(orderId, fallbackPrice);
      if (latest.filledSize > 0 && !latest.isOpen) {
        return latest;
      }
      if (!latest.isOpen) {
        return latest;
      }

      await new Promise((resolve) => setTimeout(resolve, this.config.orderFillPollIntervalMs));
    }

    return latest;
  }

  private async readOrderFill(
    orderId: string,
    fallbackPrice: number,
  ): Promise<{ filledSize: number; averagePrice: number; isOpen: boolean }> {
    let orderPayload: unknown;
    try {
      orderPayload = await this.clobClient.getOrder(orderId);
    } catch {
      return {
        filledSize: 0,
        averagePrice: fallbackPrice,
        isOpen: false,
      };
    }

    if (!orderPayload || typeof orderPayload !== "object") {
      return {
        filledSize: 0,
        averagePrice: fallbackPrice,
        isOpen: false,
      };
    }

    const orderRecord = orderPayload as Record<string, unknown>;
    const orderPrice = this.parsePositive(orderRecord.price) || fallbackPrice;
    const size = this.parsePositive(
      orderRecord.size ?? orderRecord.original_size ?? orderRecord.initial_size ?? orderRecord.amount,
    );
    const matchedSize = this.parsePositive(
      orderRecord.size_matched ?? orderRecord.sizeMatched ?? orderRecord.filled_size ?? orderRecord.filledSize,
    );
    const statusRaw = orderRecord.status;
    const status = typeof statusRaw === "string" ? statusRaw.toLowerCase() : "";
    const remainingSize = Math.max(0, size - matchedSize);
    const isOpen = status === "live" || status === "open" || status === "pending" || remainingSize > 0;

    const tradeAverage = await this.tryGetTradeAverage(orderRecord, orderPrice, matchedSize);
    return {
      filledSize: Number(matchedSize.toFixed(6)),
      averagePrice: tradeAverage,
      isOpen,
    };
  }

  private async tryGetTradeAverage(
    orderRecord: Record<string, unknown>,
    fallbackPrice: number,
    matchedSize: number,
  ): Promise<number> {
    const tradeIds = Array.isArray(orderRecord.associate_trades)
      ? orderRecord.associate_trades.filter((value): value is string => typeof value === "string")
      : [];
    if (tradeIds.length === 0 || matchedSize <= 0) {
      return fallbackPrice;
    }

    let totalNotional = 0;
    let totalSize = 0;

    for (const tradeId of tradeIds) {
      try {
        const trades = await this.clobClient.getTrades({ id: tradeId });
        for (const trade of trades) {
          if (!trade || typeof trade !== "object") {
            continue;
          }
          const record = trade as Record<string, unknown>;
          const price = this.parsePositive(record.price);
          const size = this.parsePositive(record.size);
          if (price <= 0 || size <= 0) {
            continue;
          }
          totalNotional += price * size;
          totalSize += size;
        }
      } catch {
        continue;
      }
    }

    if (totalSize <= 0) {
      return fallbackPrice;
    }

    return Number((totalNotional / totalSize).toFixed(6));
  }

  private parsePositive(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }
    return parsed;
  }
}
