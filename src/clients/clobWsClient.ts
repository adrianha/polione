import { WebSocket } from "undici";
import type { Logger } from "pino";
import type { BotConfig } from "../types/domain.js";

type Quote = {
  bestBid: number;
  bestAsk: number;
  updatedAtMs: number;
};

const parseNumber = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
};

export class ClobWsClient {
  private socket: WebSocket | null = null;
  private quotes = new Map<string, Quote>();
  private subscribedAssetIds = new Set<string>();
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.config.enableClobWs || this.stopped) {
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  ensureSubscribed(assetIds: string[]): void {
    for (const id of assetIds) {
      this.subscribedAssetIds.add(id);
    }

    if (!this.config.enableClobWs || this.stopped) {
      return;
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.start();
      return;
    }

    this.sendSubscription("subscribe", assetIds);
  }

  getFreshQuote(tokenId: string): { bestBid: number; bestAsk: number } | null {
    const quote = this.quotes.get(tokenId);
    if (!quote) {
      return null;
    }

    const ageMs = Date.now() - quote.updatedAtMs;
    if (ageMs > this.config.wsQuotesMaxAgeMs) {
      return null;
    }

    return {
      bestBid: quote.bestBid,
      bestAsk: quote.bestAsk,
    };
  }

  private connect(): void {
    this.socket = new WebSocket(this.config.clobWsUrl);

    this.socket.addEventListener("open", () => {
      this.logger.info({ wsUrl: this.config.clobWsUrl }, "CLOB websocket connected");
      this.startHeartbeat();

      if (this.subscribedAssetIds.size > 0) {
        this.sendSubscription("subscribe", Array.from(this.subscribedAssetIds));
      }
    });

    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    this.socket.addEventListener("close", () => {
      this.logger.warn("CLOB websocket disconnected");
      this.stopHeartbeat();
      this.socket = null;
      this.scheduleReconnect();
    });

    this.socket.addEventListener("error", (error) => {
      this.logger.warn({ error }, "CLOB websocket error");
    });
  }

  private sendSubscription(operation: "subscribe" | "unsubscribe", assetIds: string[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || assetIds.length === 0) {
      return;
    }

    const payload =
      operation === "subscribe"
        ? {
            assets_ids: assetIds,
            type: "market",
            custom_feature_enabled: true,
          }
        : {
            assets_ids: assetIds,
            operation: "unsubscribe",
          };

    this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(raw: unknown): void {
    const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : "";
    if (!text || text === "PONG") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        this.processWsEvent(item);
      }
      return;
    }

    this.processWsEvent(parsed);
  }

  private processWsEvent(event: unknown): void {
    console.log("Received WS event:", event);
    if (!event || typeof event !== "object") {
      return;
    }

    const record = event as Record<string, unknown>;
    const eventType =
      typeof record.event_type === "string" ? record.event_type : typeof record.type === "string" ? record.type : "";

    if (eventType !== "best_bid_ask") {
      return;
    }

    const assetId =
      typeof record.asset_id === "string" ? record.asset_id : typeof record.assetId === "string" ? record.assetId : "";
    if (!assetId) {
      return;
    }

    const bestBid = parseNumber(record.best_bid ?? record.bid ?? record.price_bid);
    const bestAsk = parseNumber(record.best_ask ?? record.ask ?? record.price_ask);
    if (bestBid <= 0 || bestAsk <= 0) {
      return;
    }

    this.quotes.set(assetId, {
      bestBid,
      bestAsk,
      updatedAtMs: Date.now(),
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.config.enableClobWs || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, this.config.wsReconnectDelayMs);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.pingTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send("PING");
      }
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
