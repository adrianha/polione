import { Context, Effect } from "effect";
import type { AppError } from "../app/errors.js";

export interface Settlement {
  readonly isAvailable: () => boolean;
  readonly getAvailableBuilderLabels: () => string[];
  readonly mergeEqualPositions: (conditionId: string, amount: number) => Effect.Effect<unknown, AppError>;
}

export const Settlement = Context.GenericTag<Settlement>("ports/Settlement");
