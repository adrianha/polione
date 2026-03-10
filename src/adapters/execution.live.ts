import { Effect, Layer } from "effect";
import { adapterError } from "../app/errors.js";
import { Execution, type Execution as ExecutionPort } from "../ports/Execution.js";
import { TradingEngine } from "../services/tradingEngine.js";
import { PolyClobClient } from "../clients/clobClient.js";

const validateReconcileResult = (value: unknown) => {
  if (!value || typeof value !== "object") {
    throw new Error("Execution reconcile result must be an object");
  }

  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "balanced" && status !== "imbalanced" && status !== "failed") {
    throw new Error("Execution reconcile result has invalid status");
  }

  const attempts = record.attempts;
  if (typeof attempts !== "number" || !Number.isFinite(attempts)) {
    throw new Error("Execution reconcile result has invalid attempts");
  }

  return value as {
    status: "balanced" | "imbalanced" | "failed";
    attempts: number;
    finalSummary: { upSize: number; downSize: number; differenceAbs: number };
    cancelledOpenOrders?: unknown[];
    reason?: string;
  };
};

export const makeExecution = (params: {
  clobClient: PolyClobClient;
  tradingEngine: TradingEngine;
}): ExecutionPort => ({
  getUsdcBalance: Effect.tryPromise({
    try: () => params.clobClient.getUsdcBalance(),
    catch: (cause) => adapterError({ adapter: "PolyClobClient", operation: "getUsdcBalance", cause }),
  }),
  placePairedLimitBuysAtPrice: (tokenIds, price, size) =>
    Effect.tryPromise({
      try: () => params.tradingEngine.placePairedLimitBuysAtPrice(tokenIds, price, size),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "placePairedLimitBuysAtPrice", cause }),
    }),
  placeSingleLimitBuyAtPrice: (tokenId, price, size) =>
    Effect.tryPromise({
      try: () => params.tradingEngine.placeSingleLimitBuyAtPrice(tokenId, price, size),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "placeSingleLimitBuyAtPrice", cause }),
    }),
  cancelEntryOpenOrders: (tokenIds) =>
    Effect.tryPromise({
      try: () => params.tradingEngine.cancelEntryOpenOrders(tokenIds),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "cancelEntryOpenOrders", cause }),
    }),
  reconcilePairedEntry: (reconcileParams) =>
    Effect.tryPromise({
      try: async () => validateReconcileResult(await params.tradingEngine.reconcilePairedEntry(reconcileParams)),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "reconcilePairedEntry", cause }),
    }),
  evaluateLiquidityForEntry: (tokenIds, entryPrice) =>
    Effect.tryPromise({
      try: () => params.tradingEngine.evaluateLiquidityForEntry(tokenIds, entryPrice),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "evaluateLiquidityForEntry", cause }),
    }),
});

export const ExecutionLive = (params: { clobClient: PolyClobClient; tradingEngine: TradingEngine }): Layer.Layer<ExecutionPort> =>
  Layer.succeed(Execution, makeExecution(params));
