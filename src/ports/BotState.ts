import { Context, Effect } from "effect";
import type { AppError } from "../app/errors.js";

export interface BotState {
  readonly loadTrackedMarkets: Effect.Effect<Set<string>, AppError>;
  readonly saveTrackedMarkets: (conditionIds: Set<string>) => Effect.Effect<void, AppError>;
}

export const BotState = Context.GenericTag<BotState>("ports/BotState");
