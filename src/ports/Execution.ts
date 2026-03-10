import { Context, Effect } from "effect";
import type { AppError } from "../app/errors.js";
import type { EntryReconcileResult, TokenIds } from "../types/domain.js";

export interface Execution {
  readonly getUsdcBalance: Effect.Effect<number, AppError>;
  readonly placePairedLimitBuysAtPrice: (
    tokenIds: TokenIds,
    price: number,
    size: number,
  ) => Effect.Effect<{ up: unknown; down: unknown }, AppError>;
  readonly placeSingleLimitBuyAtPrice: (tokenId: string, price: number, size: number) => Effect.Effect<unknown, AppError>;
  readonly cancelEntryOpenOrders: (tokenIds: TokenIds) => Effect.Effect<unknown[], AppError>;
  readonly reconcilePairedEntry: (params: {
    positionsAddress: string;
    conditionId: string;
    tokenIds: TokenIds;
    cancelOpenOrders?: boolean;
  }) => Effect.Effect<EntryReconcileResult, AppError>;
  readonly evaluateLiquidityForEntry: (tokenIds: TokenIds, entryPrice: number) => Effect.Effect<{
    allowed: boolean;
    orderSize: number;
    reason?: string;
    upSpread?: number;
    downSpread?: number;
    upDepth?: number;
    downDepth?: number;
  }, AppError>;
}

export const Execution = Context.GenericTag<Execution>("ports/Execution");
