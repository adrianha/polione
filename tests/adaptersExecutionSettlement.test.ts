import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { makeExecution } from "../src/adapters/execution.live.js";
import { makeSettlement } from "../src/adapters/settlement.live.js";

describe("effect adapters: execution + settlement", () => {
  it("routes execution calls to trading engine and clob client", async () => {
    const clobClient = {
      getUsdcBalance: vi.fn(async () => 100),
    };

    const tradingEngine = {
      placePairedLimitBuysAtPrice: vi.fn(async () => ({ up: { ok: true }, down: { ok: true } })),
      placeSingleLimitBuyAtPrice: vi.fn(async () => ({ ok: true })),
      cancelEntryOpenOrders: vi.fn(async () => []),
      reconcilePairedEntry: vi.fn(async () => ({
        status: "balanced",
        attempts: 1,
        finalSummary: { upSize: 5, downSize: 5, differenceAbs: 0 },
      })),
      evaluateLiquidityForEntry: vi.fn(async () => ({ allowed: true, orderSize: 5 })),
    };

    const adapter = makeExecution({ clobClient: clobClient as never, tradingEngine: tradingEngine as never });

    expect(await Effect.runPromise(adapter.getUsdcBalance)).toBe(100);
    expect(await Effect.runPromise(adapter.reconcilePairedEntry({ positionsAddress: "0xabc", conditionId: "c", tokenIds: { upTokenId: "u", downTokenId: "d" } }))).toMatchObject({
      status: "balanced",
    });
  });

  it("rejects malformed reconcile payloads", async () => {
    const clobClient = {
      getUsdcBalance: vi.fn(async () => 100),
    };
    const tradingEngine = {
      placePairedLimitBuysAtPrice: vi.fn(async () => ({ up: {}, down: {} })),
      placeSingleLimitBuyAtPrice: vi.fn(async () => ({})),
      cancelEntryOpenOrders: vi.fn(async () => []),
      reconcilePairedEntry: vi.fn(async () => ({ status: "balanced", attempts: 1 })),
      evaluateLiquidityForEntry: vi.fn(async () => ({ allowed: true, orderSize: 5 })),
    };

    const adapter = makeExecution({ clobClient: clobClient as never, tradingEngine: tradingEngine as never });
    await expect(
      Effect.runPromise(adapter.reconcilePairedEntry({ positionsAddress: "0xabc", conditionId: "c", tokenIds: { upTokenId: "u", downTokenId: "d" } })),
    ).rejects.toThrow();
  });

  it("exposes settlement availability and merge", async () => {
    const relayerClient = {
      isAvailable: vi.fn(() => true),
      getAvailableBuilderLabels: vi.fn(() => ["builder1"]),
    };
    const settlementService = {
      mergeEqualPositions: vi.fn(async () => ({ ok: true })),
    };

    const adapter = makeSettlement({ relayerClient: relayerClient as never, settlementService: settlementService as never });

    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.getAvailableBuilderLabels()).toEqual(["builder1"]);
    await expect(Effect.runPromise(adapter.mergeEqualPositions("cond-1", 5))).resolves.toEqual({ ok: true });
  });

  it("rejects malformed settlement metadata", async () => {
    const relayerClient = {
      isAvailable: vi.fn(() => true),
      getAvailableBuilderLabels: vi.fn(() => ["builder1"]),
    };
    const settlementService = {
      mergeEqualPositions: vi.fn(async () => ({ meta: { builderLabel: 123 } })),
    };

    const adapter = makeSettlement({ relayerClient: relayerClient as never, settlementService: settlementService as never });
    await expect(Effect.runPromise(adapter.mergeEqualPositions("cond-1", 5))).rejects.toThrow();
  });
});
