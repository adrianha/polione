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

  clearQuotes(assetIds?: string[]): void {
    if (!assetIds || assetIds.length === 0) {
      this.quotes.clear();
      return;
    }

    for (const assetId of assetIds) {
      this.quotes.delete(assetId);
    }
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
    const text =
      typeof raw === "string"
        ? raw
        : raw instanceof Uint8Array
          ? Buffer.from(raw).toString("utf8")
          : "";
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
    if (!event || typeof event !== "object") {
      return;
    }

    const record = event as Record<string, unknown>;
    const payload =
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : record;

    const assetId =
      typeof payload.asset_id === "string"
        ? payload.asset_id
        : typeof payload.assetId === "string"
          ? payload.assetId
          : typeof payload.token_id === "string"
            ? payload.token_id
            : typeof payload.tokenId === "string"
              ? payload.tokenId
              : "";
    if (!assetId) {
      return;
    }

    const bestBid = parseNumber(
      payload.best_bid ?? payload.bid ?? payload.price_bid ?? payload.bbo_bid ?? payload.bb,
    );
    const bestAsk = parseNumber(
      payload.best_ask ?? payload.ask ?? payload.price_ask ?? payload.bbo_ask ?? payload.ba,
    );
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
    }, 4000);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
