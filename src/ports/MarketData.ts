import { Context, Effect } from "effect";
import type { AppError } from "../app/errors.js";
import type { MarketRecord, TokenIds } from "../types/domain.js";

export interface MarketData {
  readonly findCurrentActiveMarket: Effect.Effect<MarketRecord | null, AppError>;
  readonly findNextActiveMarket: Effect.Effect<MarketRecord | null, AppError>;
  readonly getTokenIds: (market: MarketRecord) => TokenIds | null;
  readonly getConditionId: (market: MarketRecord) => string | null;
  readonly getSecondsToMarketClose: (market: MarketRecord) => number | null;
}

export const MarketData = Context.GenericTag<MarketData>("ports/MarketData");
