import { Effect, Layer } from "effect";
import { adapterError } from "../app/errors.js";
import { BotState, type BotState as BotStatePort } from "../ports/BotState.js";
import { StateStore } from "../utils/stateStore.js";

export const makeFileBotState = (store: StateStore): BotStatePort => ({
  loadTrackedMarkets: Effect.tryPromise({
    try: async () => {
      const value = await store.loadTrackedMarkets();
      if (!(value instanceof Set)) {
        throw new Error("StateStore loadTrackedMarkets must return a Set");
      }

      for (const conditionId of value) {
        if (typeof conditionId !== "string" || conditionId.length === 0) {
          throw new Error("StateStore tracked market IDs must be non-empty strings");
        }
      }

      return value;
    },
    catch: (cause) => adapterError({ adapter: "StateStore", operation: "loadTrackedMarkets", cause }),
  }),
  saveTrackedMarkets: (conditionIds) =>
    Effect.tryPromise({
      try: async () => {
        for (const conditionId of conditionIds) {
          if (typeof conditionId !== "string" || conditionId.length === 0) {
            throw new Error("StateStore tracked market IDs must be non-empty strings");
          }
        }

        await store.saveTrackedMarkets(conditionIds);
      },
      catch: (cause) => adapterError({ adapter: "StateStore", operation: "saveTrackedMarkets", cause }),
    }),
});

export const FileBotStateLive = (store: StateStore): Layer.Layer<BotStatePort> => Layer.succeed(BotState, makeFileBotState(store));
