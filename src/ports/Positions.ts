import { Context, Effect } from "effect";
import type { AppError } from "../app/errors.js";
import type { PositionRecord } from "../types/domain.js";

export interface Positions {
  readonly getPositions: (positionsAddress: string, conditionId?: string) => Effect.Effect<PositionRecord[], AppError>;
}

export const Positions = Context.GenericTag<Positions>("ports/Positions");
