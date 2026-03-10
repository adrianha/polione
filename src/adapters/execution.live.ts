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

  const finalSummary = record.finalSummary;
  if (!finalSummary || typeof finalSummary !== "object") {
    throw new Error("Execution reconcile result missing finalSummary");
  }

  const summary = finalSummary as Record<string, unknown>;
  for (const key of ["upSize", "downSize", "differenceAbs"] as const) {
    const field = summary[key];
    if (typeof field !== "number" || !Number.isFinite(field)) {
      throw new Error(`Execution reconcile result finalSummary.${key} must be a finite number`);
    }
  }

  return value as {
    status: "balanced" | "imbalanced" | "failed";
    attempts: number;
    finalSummary: { upSize: number; downSize: number; differenceAbs: number };
    cancelledOpenOrders?: unknown[];
    reason?: string;
  };
};

const validatePairedResult = (value: unknown): { up: unknown; down: unknown } => {
  if (!value || typeof value !== "object") {
    throw new Error("Execution paired order result must be an object");
  }

  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "up") || !Object.hasOwn(record, "down")) {
    throw new Error("Execution paired order result must include up and down fields");
  }

  return value as { up: unknown; down: unknown };
};

const validateCancelResult = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error("Execution cancel result must be an array");
  }

  return value;
};

const validateLiquidityResult = (value: unknown): {
  allowed: boolean;
  orderSize: number;
  reason?: string;
  upSpread?: number;
  downSpread?: number;
  upDepth?: number;
  downDepth?: number;
} => {
  if (!value || typeof value !== "object") {
    throw new Error("Execution liquidity result must be an object");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.allowed !== "boolean") {
    throw new Error("Execution liquidity result 'allowed' must be boolean");
  }
  if (typeof record.orderSize !== "number" || !Number.isFinite(record.orderSize)) {
    throw new Error("Execution liquidity result 'orderSize' must be a finite number");
  }
  if (record.reason !== undefined && typeof record.reason !== "string") {
    throw new Error("Execution liquidity result 'reason' must be string when present");
  }

  for (const optionalNumber of ["upSpread", "downSpread", "upDepth", "downDepth"] as const) {
    const field = record[optionalNumber];
    if (field !== undefined && (typeof field !== "number" || !Number.isFinite(field))) {
      throw new Error(`Execution liquidity result '${optionalNumber}' must be a finite number when present`);
    }
  }

  return value as {
    allowed: boolean;
    orderSize: number;
    reason?: string;
    upSpread?: number;
    downSpread?: number;
    upDepth?: number;
    downDepth?: number;
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
      try: async () => validatePairedResult(await params.tradingEngine.placePairedLimitBuysAtPrice(tokenIds, price, size)),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "placePairedLimitBuysAtPrice", cause }),
    }),
  placeSingleLimitBuyAtPrice: (tokenId, price, size) =>
    Effect.tryPromise({
      try: () => params.tradingEngine.placeSingleLimitBuyAtPrice(tokenId, price, size),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "placeSingleLimitBuyAtPrice", cause }),
    }),
  cancelEntryOpenOrders: (tokenIds) =>
    Effect.tryPromise({
      try: async () => validateCancelResult(await params.tradingEngine.cancelEntryOpenOrders(tokenIds)),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "cancelEntryOpenOrders", cause }),
    }),
  reconcilePairedEntry: (reconcileParams) =>
    Effect.tryPromise({
      try: async () => validateReconcileResult(await params.tradingEngine.reconcilePairedEntry(reconcileParams)),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "reconcilePairedEntry", cause }),
    }),
  evaluateLiquidityForEntry: (tokenIds, entryPrice) =>
    Effect.tryPromise({
      try: async () => validateLiquidityResult(await params.tradingEngine.evaluateLiquidityForEntry(tokenIds, entryPrice)),
      catch: (cause) => adapterError({ adapter: "TradingEngine", operation: "evaluateLiquidityForEntry", cause }),
    }),
});

export const ExecutionLive = (params: { clobClient: PolyClobClient; tradingEngine: TradingEngine }): Layer.Layer<ExecutionPort> =>
  Layer.succeed(Execution, makeExecution(params));
