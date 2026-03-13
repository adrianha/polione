import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/types/domain.js";

type WsListener = (event?: { data?: unknown }) => void;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners: Record<string, WsListener[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: WsListener): void {
    this.listeners[type].push(listener);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data });
  }

  emitError(): void {
    this.emit("error");
  }

  private emit(type: "open" | "message" | "close" | "error", event?: { data?: unknown }): void {
    for (const listener of this.listeners[type]) {
      listener(event);
    }
  }
}

vi.mock("undici", () => ({
  WebSocket: MockWebSocket,
}));

const { ClobWsClient } = await import("../src/clients/clobWsClient.js");

const baseConfig: BotConfig = {
  dryRun: true,
  privateKey: `0x${"1".repeat(64)}`,
  signatureType: 0,
  chainId: 137,
  clobApiHost: "https://clob.polymarket.com",
  clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  enableClobWs: true,
  wsQuotesMaxAgeMs: 2000,
  wsReconnectDelayMs: 2000,
  gammaApiBaseUrl: "https://gamma-api.polymarket.com",
  dataApiBaseUrl: "https://data-api.polymarket.com",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  builderApiKey2: undefined,
  builderApiSecret2: undefined,
  builderApiPassphrase2: undefined,
  marketSlugPrefix: "btc-updown-5m",
  marketIntervalSeconds: 300,
  orderPrice: 0.35,
  orderSize: 5,
  positionEqualityTolerance: 0.01,
  forceSellThresholdSeconds: 15,
  loopSleepSeconds: 10,
  currentLoopSleepSeconds: 3,
  redeemLoopSleepSeconds: 60,
  redeemEnabled: true,
  redeemMaxRetries: 8,
  redeemRetryBackoffMs: 60_000,
  redeemSuccessCooldownMs: 300_000,
  redeemMaxPerLoop: 20,
  redeemTerminalStateTtlMs: 604_800_000,
  positionRecheckSeconds: 60,
  entryReconcileSeconds: 15,
  entryReconcilePollSeconds: 3,
  entryCancelOpenOrders: true,
  forceWindowFeeBuffer: 0.01,
  forceWindowMinProfitPerShare: 0.005,
  entryContinuousRepriceEnabled: true,
  entryContinuousRepriceIntervalMs: 1500,
  entryContinuousMinPriceDelta: 0.002,
  entryContinuousMaxDurationSeconds: 45,
  entryContinuousMakerOffset: 0.001,
  entryRecoveryHorizonSeconds: 120,
  entryRecoveryExtraProfitMax: 0.01,
  entryRecoveryMinSizeFraction: 0.35,
  entryRecoveryPassiveOffsetMax: 0.004,
  requestTimeoutMs: 30000,
  requestRetries: 0,
  requestRetryBackoffMs: 0,
  stateFilePath: ".bot-state.test.json",
  logLevel: "info",
};

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
});

describe("clob websocket client", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useRealTimers();
  });

  it("subscribes and parses best bid/ask events", () => {
    const logger = createLogger();
    const client = new ClobWsClient(baseConfig, logger as never);

    client.ensureSubscribed(["up-token", "down-token"]);
    expect(MockWebSocket.instances.length).toBe(1);

    const socket = MockWebSocket.instances[0];
    socket.emitOpen();

    const subscription = socket.sent
      .map((item) => JSON.parse(item))
      .find((item) => item.type === "market" && Array.isArray(item.assets_ids));
    expect(subscription).toBeDefined();
    expect(subscription.assets_ids).toEqual(expect.arrayContaining(["up-token", "down-token"]));

    socket.emitMessage(
      JSON.stringify({
        event_type: "best_bid_ask",
        asset_id: "down-token",
        best_bid: "0.342",
        best_ask: "0.346",
      }),
    );

    expect(client.getFreshQuote("down-token")).toEqual({ bestBid: 0.342, bestAsk: 0.346 });
  });

  it("accepts array payloads and alias fields", () => {
    const logger = createLogger();
    const client = new ClobWsClient(baseConfig, logger as never);

    client.ensureSubscribed(["asset-1"]);
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();

    socket.emitMessage(
      JSON.stringify([
        {
          type: "best_bid_ask",
          assetId: "asset-1",
          bid: 0.31,
          ask: 0.33,
        },
      ]),
    );

    expect(client.getFreshQuote("asset-1")).toEqual({ bestBid: 0.31, bestAsk: 0.33 });
  });

  it("expires stale quotes based on max age", () => {
    const logger = createLogger();
    const client = new ClobWsClient(baseConfig, logger as never);

    client.ensureSubscribed(["asset-2"]);
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    socket.emitMessage(
      JSON.stringify({
        event_type: "best_bid_ask",
        asset_id: "asset-2",
        best_bid: "0.2",
        best_ask: "0.22",
      }),
    );

    expect(client.getFreshQuote("asset-2")).toEqual({ bestBid: 0.2, bestAsk: 0.22 });

    const quotes = (
      client as unknown as { quotes: Map<string, { bestBid: number; bestAsk: number; updatedAtMs: number }> }
    ).quotes;
    const current = quotes.get("asset-2");
    expect(current).toBeDefined();
    quotes.set("asset-2", {
      bestBid: current!.bestBid,
      bestAsk: current!.bestAsk,
      updatedAtMs: Date.now() - (baseConfig.wsQuotesMaxAgeMs + 1),
    });

    expect(client.getFreshQuote("asset-2")).toBeNull();
  });

  it("reconnects after close and re-subscribes", async () => {
    const logger = createLogger();
    const config = { ...baseConfig, wsReconnectDelayMs: 500 };
    const client = new ClobWsClient(config, logger as never);

    client.ensureSubscribed(["asset-3"]);
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.emitOpen();

    firstSocket.close();
    await new Promise((resolve) => setTimeout(resolve, config.wsReconnectDelayMs + 10));

    expect(MockWebSocket.instances.length).toBe(2);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.emitOpen();

    const resubscription = secondSocket.sent
      .map((item) => JSON.parse(item))
      .find((item) => item.type === "market" && Array.isArray(item.assets_ids));
    expect(resubscription).toBeDefined();
    expect(resubscription.assets_ids).toContain("asset-3");
  });
});
