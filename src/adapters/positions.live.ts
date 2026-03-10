import { Effect, Layer } from "effect";
import { adapterError } from "../app/errors.js";
import { Positions, type Positions as PositionsPort } from "../ports/Positions.js";
import type { PositionRecord } from "../types/domain.js";
import { DataClient } from "../clients/dataClient.js";

const parsePositionRecord = (value: unknown): PositionRecord => {
  if (!value || typeof value !== "object") {
    throw new Error("Data position payload must be an object");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.asset !== "string" || typeof record.conditionId !== "string") {
    throw new Error("Data position payload missing required fields: asset, conditionId");
  }
  if (record.asset.length === 0 || record.conditionId.length === 0) {
    throw new Error("Data position payload fields 'asset' and 'conditionId' must be non-empty strings");
  }

  const sizeRaw = record.size;
  const size = typeof sizeRaw === "number" ? sizeRaw : Number(sizeRaw);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error("Data position payload field 'size' must be a finite non-negative number");
  }

  const out: PositionRecord = {
    ...record,
    asset: record.asset,
    conditionId: record.conditionId,
    size,
  };

  if (record.outcome !== undefined && typeof record.outcome !== "string") {
    throw new Error("Data position payload field 'outcome' must be string when present");
  }
  if (record.outcome !== undefined) {
    out.outcome = record.outcome;
  }

  return out;
};

export const makePositions = (client: DataClient): PositionsPort => ({
  getPositions: (positionsAddress, conditionId) =>
    Effect.tryPromise({
      try: async () => {
        const payload = await client.getPositions(positionsAddress, conditionId);
        return payload.map((item) => parsePositionRecord(item));
      },
      catch: (cause) => adapterError({ adapter: "DataClient", operation: "getPositions", cause }),
    }),
});

export const PositionsLive = (client: DataClient): Layer.Layer<PositionsPort> => Layer.succeed(Positions, makePositions(client));
