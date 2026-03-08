import type { PositionRecord, PositionSummary, TokenIds } from "../types/domain.js";

const parseOutcome = (value?: string): "UP" | "DOWN" | null => {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized.includes("UP") || normalized.includes("YES")) {
    return "UP";
  }
  if (normalized.includes("DOWN") || normalized.includes("NO")) {
    return "DOWN";
  }
  return null;
};

export const summarizePositions = (positions: PositionRecord[], tokenIds: TokenIds): PositionSummary => {
  let up = 0;
  let down = 0;

  for (const position of positions) {
    const size = Number(position.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) {
      continue;
    }

    if (position.asset === tokenIds.upTokenId) {
      up += size;
      continue;
    }

    if (position.asset === tokenIds.downTokenId) {
      down += size;
      continue;
    }

    const outcome = parseOutcome(position.outcome);
    if (outcome === "UP") {
      up += size;
    } else if (outcome === "DOWN") {
      down += size;
    }
  }

  return {
    upSize: up,
    downSize: down,
    differenceAbs: Math.abs(up - down),
  };
};

export const arePositionsEqual = (summary: PositionSummary, tolerance: number): boolean => {
  return summary.differenceAbs <= tolerance;
};
