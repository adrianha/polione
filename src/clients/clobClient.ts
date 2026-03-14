import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  type PostOrdersArgs,
  type OrderBookSummary,
  Side,
  SignatureType,
  type OrderPayload,
  type OpenOrdersResponse,
  type TickSize,
} from "@polymarket/clob-client";
import type { BotConfig, Side as BotSide, TradeIntent } from "../types/domain.js";
import { Wallet } from "ethers";

const toSdkSide = (side: BotSide): Side => (side === "BUY" ? Side.BUY : Side.SELL);

const toSdkChain = (chainId: 137 | 80002): Chain => (chainId === 137 ? Chain.POLYGON : Chain.AMOY);

export class PolyClobClient {
  private readonly wallet: Wallet;
  private client: ClobClient;

  constructor(private readonly config: BotConfig) {
    this.wallet = new Wallet(config.privateKey);
    this.client = new ClobClient(
      config.clobApiHost,
      toSdkChain(config.chainId),
      this.wallet,
      undefined,
      config.signatureType as SignatureType,
      config.funder,
      undefined,
      true,
    );
  }

  async init(): Promise<void> {
    const creds = await this.client.createOrDeriveApiKey();
    this.client = new ClobClient(
      this.config.clobApiHost,
      toSdkChain(this.config.chainId),
      this.wallet,
      creds,
      this.config.signatureType as SignatureType,
      this.config.funder,
      undefined,
      true,
    );
  }

  getSignerAddress(): string {
    return this.wallet.address;
  }

  async placeLimitOrder(params: {
    tokenId: string;
    side: BotSide;
    price: number;
    size: number;
    tickSize?: TickSize;
    negRisk?: boolean;
  }): Promise<unknown> {
    if (this.config.dryRun) {
      const intent: TradeIntent = {
        action: "PLACE_LIMIT",
        payload: params,
      };
      return { dryRun: true, intent };
    }

    return this.client.createAndPostOrder(
      {
        tokenID: params.tokenId,
        side: toSdkSide(params.side),
        price: params.price,
        size: params.size,
      },
      {
        tickSize: params.tickSize ?? "0.01",
        negRisk: params.negRisk ?? false,
      },
      OrderType.GTC,
    );
  }

  async placeLimitOrdersBatch(
    params: Array<{
      tokenId: string;
      side: BotSide;
      price: number;
      size: number;
      tickSize?: TickSize;
      negRisk?: boolean;
      postOnly?: boolean;
    }>,
  ): Promise<unknown> {
    if (this.config.dryRun) {
      const intents: TradeIntent[] = params.map((item) => ({
        action: "PLACE_LIMIT",
        payload: item,
      }));
      return { dryRun: true, intents };
    }

    const ordersArgs: PostOrdersArgs[] = [];
    for (const item of params) {
      const order = await this.client.createOrder(
        {
          tokenID: item.tokenId,
          side: toSdkSide(item.side),
          price: item.price,
          size: item.size,
        },
        {
          tickSize: item.tickSize ?? "0.01",
          negRisk: item.negRisk ?? false,
        },
      );

      ordersArgs.push({
        order,
        orderType: OrderType.GTC,
        postOnly: item.postOnly,
      });
    }

    return this.client.postOrders(ordersArgs);
  }

  async placeMarketOrder(params: {
    tokenId: string;
    side: BotSide;
    amount: number;
    price?: number;
    orderType?: OrderType.FOK | OrderType.FAK;
    tickSize?: TickSize;
    negRisk?: boolean;
  }): Promise<unknown> {
    if (this.config.dryRun) {
      const intent: TradeIntent = {
        action: "PLACE_MARKET",
        payload: params,
      };
      return { dryRun: true, intent };
    }

    return this.client.createAndPostMarketOrder(
      {
        tokenID: params.tokenId,
        side: toSdkSide(params.side),
        amount: params.amount,
        price: params.price,
      },
      {
        tickSize: params.tickSize ?? "0.01",
        negRisk: params.negRisk ?? false,
      },
      params.orderType ?? OrderType.FAK,
    );
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    if (this.config.dryRun) {
      const intent: TradeIntent = {
        action: "CANCEL_ORDER",
        payload: { orderId },
      };
      return { dryRun: true, intent };
    }
    const payload: OrderPayload = { orderID: orderId };
    return this.client.cancelOrder(payload);
  }

  async cancelOrders(orderIds: string[]): Promise<unknown> {
    if (orderIds.length === 0) {
      return [];
    }

    if (this.config.dryRun) {
      const intents: TradeIntent[] = orderIds.map((orderId) => ({
        action: "CANCEL_ORDER",
        payload: { orderId },
      }));
      return { dryRun: true, intents };
    }

    return this.client.cancelOrders(orderIds);
  }

  async getOpenOrders(): Promise<OpenOrdersResponse> {
    return this.client.getOpenOrders();
  }

  async getOrder(orderId: string): Promise<unknown> {
    return this.client.getOrder(orderId);
  }

  async getTrades(params?: {
    id?: string;
    makerAddress?: string;
    market?: string;
    assetId?: string;
    before?: string;
    after?: string;
  }): Promise<unknown[]> {
    const trades = await this.client.getTrades(
      params
        ? {
            id: params.id,
            maker_address: params.makerAddress,
            market: params.market,
            asset_id: params.assetId,
            before: params.before,
            after: params.after,
          }
        : undefined,
    );
    return Array.isArray(trades) ? trades : [];
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSummary> {
    return this.client.getOrderBook(tokenId);
  }

  async getPrice(tokenId: string, side: "BUY" | "SELL"): Promise<number> {
    const response = await this.client.getPrice(tokenId, side);
    if (typeof response === "number") {
      return Number.isFinite(response) && response > 0 ? response : 0;
    }

    if (!response || typeof response !== "object") {
      return 0;
    }

    const record = response as Record<string, unknown>;
    const value = record.price ?? record.value ?? record.best_price ?? record.bestPrice;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return parsed;
  }

  async cancelOpenOrdersForTokenIds(tokenIds: string[]): Promise<unknown[]> {
    const uniqueTokenIds = new Set(tokenIds);
    if (uniqueTokenIds.size === 0) {
      return [];
    }

    const openOrders = await this.getOpenOrders();
    const records = Array.isArray(openOrders) ? openOrders : [];

    const matches = records.filter((record) => {
      const tokenId =
        (record as { tokenID?: unknown }).tokenID ??
        (record as { tokenId?: unknown }).tokenId ??
        (record as { asset_id?: unknown }).asset_id ??
        (record as { assetId?: unknown }).assetId;

      return typeof tokenId === "string" && uniqueTokenIds.has(tokenId);
    });

    const orderIds = Array.from(
      new Set(
        matches
          .map((record) => {
            const orderId =
              (record as { id?: unknown }).id ??
              (record as { orderID?: unknown }).orderID ??
              (record as { orderId?: unknown }).orderId ??
              (record as { order_id?: unknown }).order_id;
            return typeof orderId === "string" && orderId ? orderId : null;
          })
          .filter((value): value is string => value !== null),
      ),
    );

    if (orderIds.length === 0) {
      return [];
    }

    try {
      const batchCancel = await this.cancelOrders(orderIds);
      return Array.isArray(batchCancel) ? batchCancel : [batchCancel];
    } catch {
      const results: unknown[] = [];
      for (const orderId of orderIds) {
        results.push(await this.cancelOrder(orderId));
      }
      return results;
    }
  }

  async getUsdcBalance(): Promise<number> {
    const response = await this.client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    const parsed = Number(response.balance);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid balance response: ${response.balance}`);
    }
    return parsed;
  }
}
