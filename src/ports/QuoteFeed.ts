import { Context, Effect } from "effect";
import type { AppError } from "../app/errors.js";

export interface QuoteFeed {
  readonly start: Effect.Effect<void, AppError>;
  readonly stop: Effect.Effect<void, AppError>;
  readonly ensureSubscribed: (assetIds: string[]) => Effect.Effect<void, AppError>;
  readonly getFreshQuote: (tokenId: string) => Effect.Effect<{ bestBid: number; bestAsk: number } | null, AppError>;
}

export const QuoteFeed = Context.GenericTag<QuoteFeed>("ports/QuoteFeed");
