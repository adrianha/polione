import { Effect, Layer } from "effect";
import { adapterError } from "../app/errors.js";
import { Settlement, type Settlement as SettlementPort } from "../ports/Settlement.js";
import { SettlementService } from "../services/settlement.js";
import { PolyRelayerClient } from "../clients/relayerClient.js";

const validateSettlementResult = (value: unknown): unknown => {
  if (value === null) {
    return value;
  }

  if (!value || typeof value !== "object") {
    throw new Error("Settlement result must be an object or null");
  }

  const record = value as Record<string, unknown>;
  if (record.skipped === true && typeof record.reason !== "string") {
    throw new Error("Settlement skipped result must include string reason");
  }

  if (record.meta !== undefined) {
    if (!record.meta || typeof record.meta !== "object") {
      throw new Error("Settlement result meta must be an object when present");
    }
    const meta = record.meta as Record<string, unknown>;
    if (typeof meta.builderLabel !== "string") {
      throw new Error("Settlement result meta.builderLabel must be a string when present");
    }
  }

  return value;
};

export const makeSettlement = (params: {
  relayerClient: PolyRelayerClient;
  settlementService: SettlementService;
}): SettlementPort => ({
  isAvailable: () => params.relayerClient.isAvailable(),
  getAvailableBuilderLabels: () => params.relayerClient.getAvailableBuilderLabels(),
  mergeEqualPositions: (conditionId, amount) =>
    Effect.tryPromise({
      try: async () => validateSettlementResult(await params.settlementService.mergeEqualPositions(conditionId, amount)),
      catch: (cause) => adapterError({ adapter: "SettlementService", operation: "mergeEqualPositions", cause }),
    }),
});

export const SettlementLive = (params: {
  relayerClient: PolyRelayerClient;
  settlementService: SettlementService;
}): Layer.Layer<SettlementPort> => Layer.succeed(Settlement, makeSettlement(params));
