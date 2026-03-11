import { describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/types/domain.js";

const executeMocks: Array<ReturnType<typeof vi.fn>> = [];

vi.mock("@polymarket/builder-relayer-client", () => {
  class MockRelayClient {
    private readonly executeImpl: (...args: unknown[]) => unknown;

    constructor() {
      const executeImpl = vi.fn();
      executeMocks.push(executeImpl);
      this.executeImpl = executeImpl as (...args: unknown[]) => unknown;
    }

    execute(txs: unknown[], note: string) {
      return this.executeImpl(txs, note);
    }
  }

  return {
    RelayClient: MockRelayClient,
    RelayerTxType: {
      PROXY: "PROXY",
    },
  };
});

const { PolyRelayerClient } = await import("../src/clients/relayerClient.js");
const { loadConfig } = await import("../src/config/env.js");

const baseConfig: BotConfig = {
  dryRun: false,
  privateKey: `0x${"1".repeat(64)}`,
  signatureType: 0,
  chainId: 137,
  clobApiHost: "https://clob.polymarket.com",
  clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  enableClobWs: false,
  wsQuotesMaxAgeMs: 2000,
  wsReconnectDelayMs: 2000,
  gammaApiBaseUrl: "https://gamma-api.polymarket.com",
  dataApiBaseUrl: "https://data-api.polymarket.com",
  polygonRpc: "https://polygon-rpc.com",
  polymarketRelayerUrl: "https://relayer-v2.polymarket.com",
  builderApiKey: "builder-1-key",
  builderApiSecret: "builder-1-secret",
  builderApiPassphrase: "builder-1-passphrase",
  builderApiKey2: "builder-2-key",
  builderApiSecret2: "builder-2-secret",
  builderApiPassphrase2: "builder-2-passphrase",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  marketSlugPrefix: "btc-updown-5m",
  marketIntervalSeconds: 300,
  orderPrice: 0.46,
  orderSize: 5,
  positionEqualityTolerance: 0.01,
  forceSellThresholdSeconds: 30,
  loopSleepSeconds: 10,
  currentLoopSleepSeconds: 3,
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
  requestTimeoutMs: 30000,
  requestRetries: 0,
  requestRetryBackoffMs: 0,
  stateFilePath: ".bot-state.test.json",
  logLevel: "info",
};

describe("relayer failover", () => {
  it("fails over to builder2 on confirmed rate-limit error", async () => {
    executeMocks.length = 0;
    const client = new PolyRelayerClient(baseConfig);

    executeMocks[0].mockRejectedValueOnce(new Error("429 too many requests resets in 30 seconds"));
    executeMocks[1].mockResolvedValueOnce({ txHash: "0xabc" });

    const result = await client.mergeTokens("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1n);

    expect(executeMocks[0]).toHaveBeenCalledTimes(1);
    expect(executeMocks[1]).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      txHash: "0xabc",
      meta: {
        builderLabel: "builder2",
        failoverFrom: "builder1",
      },
    });
  });

  it("returns to builder1 after builder1 cooldown expires and builder2 becomes rate-limited", async () => {
    executeMocks.length = 0;
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);
    const client = new PolyRelayerClient(baseConfig);

    executeMocks[0].mockRejectedValueOnce(new Error("429 too many requests resets in 2 seconds"));
    executeMocks[1].mockResolvedValueOnce({ txHash: "0xfirst" });

    const first = await client.mergeTokens("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1n);
    expect(first).toMatchObject({
      meta: {
        builderLabel: "builder2",
        failoverFrom: "builder1",
      },
    });

    nowSpy.mockReturnValue(3_500);
    executeMocks[0].mockResolvedValueOnce({ txHash: "0xsecond" });

    const second = await client.mergeTokens("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1n);

    expect(executeMocks[0]).toHaveBeenCalledTimes(2);
    expect(executeMocks[1]).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      txHash: "0xsecond",
      meta: {
        builderLabel: "builder1",
      },
    });
  });

  it("returns skipped result when both builders are rate-limited", async () => {
    executeMocks.length = 0;
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(10_000);
    const client = new PolyRelayerClient(baseConfig);

    executeMocks[0].mockRejectedValueOnce(new Error("429 too many requests resets in 9 seconds"));
    executeMocks[1].mockRejectedValueOnce(new Error("429 too many requests resets in 5 seconds"));

    const result = await client.mergeTokens("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1n);

    expect(result).toEqual({
      skipped: true,
      reason: "relayer_rate_limited",
      retryAt: 15_000,
    });
  });

  it("does not fail over on non-rate-limit error", async () => {
    executeMocks.length = 0;
    const client = new PolyRelayerClient(baseConfig);

    executeMocks[0].mockRejectedValueOnce(new Error("403 forbidden"));

    await expect(
      client.mergeTokens("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1n),
    ).rejects.toThrow("403 forbidden");

    expect(executeMocks[0]).toHaveBeenCalledTimes(1);
    expect(executeMocks[1]).toHaveBeenCalledTimes(0);
  });
});

describe("builder env validation", () => {
  it("rejects partial secondary builder credentials", () => {
    const env = {
      DRY_RUN: "false",
      PRIVATE_KEY: `0x${"1".repeat(64)}`,
      CHAIN_ID: "137",
      CLOB_API_HOST: "https://clob.polymarket.com",
      CLOB_WS_URL: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      ENABLE_CLOB_WS: "false",
      WS_QUOTES_MAX_AGE_MS: "2000",
      WS_RECONNECT_DELAY_MS: "2000",
      GAMMA_API_BASE_URL: "https://gamma-api.polymarket.com",
      DATA_API_BASE_URL: "https://data-api.polymarket.com",
      POLYGON_RPC: "https://polygon-rpc.com",
      POLYMARKET_RELAYER_URL: "https://relayer-v2.polymarket.com",
      BUILDER_API_KEY: "builder-1-key",
      BUILDER_API_SECRET: "builder-1-secret",
      BUILDER_API_PASSPHRASE: "builder-1-passphrase",
      BUILDER_API_KEY_2: "builder-2-key",
    };

    const previousEnv = process.env;
    process.env = { ...previousEnv, ...env };

    try {
      expect(() => loadConfig()).toThrow("Invalid secondary builder credentials configuration");
    } finally {
      process.env = previousEnv;
    }
  });
});
