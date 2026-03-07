import {
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureType,
  type OrderPayload,
  type OpenOrdersResponse,
  type TickSize
} from "@polymarket/clob-client";
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { BotConfig, Side as BotSide, TradeIntent } from "../types/domain.js";

const toSdkSide = (side: BotSide): Side => (side === "BUY" ? Side.BUY : Side.SELL);

const toSdkChain = (chainId: 137 | 80002): Chain => (chainId === 137 ? Chain.POLYGON : Chain.AMOY);

export class PolyClobClient {
  private readonly walletClient: WalletClient;
  private client: ClobClient;

  constructor(private readonly config: BotConfig) {
    const account = privateKeyToAccount(config.privateKey);
    this.walletClient = createWalletClient({
      account,
      chain: config.chainId === 137 ? polygon : polygonAmoy,
      transport: http(config.polygonRpc)
    });

    this.client = new ClobClient(
      config.clobApiHost,
      toSdkChain(config.chainId),
      this.walletClient,
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
      this.walletClient,
      creds,
      this.config.signatureType as SignatureType,
      this.config.funder,
      undefined,
      true
    );
  }

  async getSignerAddress(): Promise<string> {
    const [address] = await this.walletClient.getAddresses();
    return address;
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
}
