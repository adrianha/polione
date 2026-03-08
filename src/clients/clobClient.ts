import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  type PostOrdersArgs,
  Side,
  SignatureType,
  type OrderPayload,
  type OpenOrdersResponse,
  type TickSize
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
      true
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
      true
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
        payload: params
      };
      return { dryRun: true, intent };
    }

    return this.client.createAndPostOrder(
      {
        tokenID: params.tokenId,
        side: toSdkSide(params.side),
        price: params.price,
        size: params.size
      },
      {
        tickSize: params.tickSize ?? "0.01",
        negRisk: params.negRisk ?? false
      },
      OrderType.GTC
    );
  }

  async placeLimitOrdersBatch(params: Array<{
    tokenId: string;
    side: BotSide;
    price: number;
    size: number;
    tickSize?: TickSize;
    negRisk?: boolean;
    postOnly?: boolean;
  }>): Promise<unknown> {
    if (this.config.dryRun) {
      const intents: TradeIntent[] = params.map((item) => ({
        action: "PLACE_LIMIT",
        payload: item
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
          size: item.size
        },
        {
          tickSize: item.tickSize ?? "0.01",
          negRisk: item.negRisk ?? false
        }
      );

      ordersArgs.push({
        order,
        orderType: OrderType.GTC,
        postOnly: item.postOnly
      });
    }

    return this.client.postOrders(ordersArgs);
  }

  async placeMarketOrder(params: {
    tokenId: string;
    side: BotSide;
    amount: number;
    price?: number;
    tickSize?: TickSize;
    negRisk?: boolean;
  }): Promise<unknown> {
    if (this.config.dryRun) {
      const intent: TradeIntent = {
        action: "PLACE_MARKET",
        payload: params
      };
      return { dryRun: true, intent };
    }

    return this.client.createAndPostMarketOrder(
      {
        tokenID: params.tokenId,
        side: toSdkSide(params.side),
        amount: params.amount,
        price: params.price
      },
      {
        tickSize: params.tickSize ?? "0.01",
        negRisk: params.negRisk ?? false
      },
      OrderType.FOK
    );
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    if (this.config.dryRun) {
      const intent: TradeIntent = {
        action: "CANCEL_ORDER",
        payload: { orderId }
      };
      return { dryRun: true, intent };
    }
    const payload: OrderPayload = { orderID: orderId };
    return this.client.cancelOrder(payload);
  }

  async getOpenOrders(): Promise<OpenOrdersResponse> {
    return this.client.getOpenOrders();
  }

  async getUsdcBalance(): Promise<number> {
    const response = await this.client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL
    });
    const parsed = Number(response.balance);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid balance response: ${response.balance}`);
    }
    return parsed;
  }
}
