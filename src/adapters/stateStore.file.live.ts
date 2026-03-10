import { Effect, Layer } from "effect";
import { adapterError } from "../app/errors.js";
import { BotState, type BotState as BotStatePort } from "../ports/BotState.js";
import { StateStore } from "../utils/stateStore.js";

export const makeFileBotState = (store: StateStore): BotStatePort => ({
  loadTrackedMarkets: Effect.tryPromise({
    try: () => store.loadTrackedMarkets(),
    catch: (cause) => adapterError({ adapter: "StateStore", operation: "loadTrackedMarkets", cause }),
  }),
  saveTrackedMarkets: (conditionIds) =>
    Effect.tryPromise({
      try: () => store.saveTrackedMarkets(conditionIds),
      catch: (cause) => adapterError({ adapter: "StateStore", operation: "saveTrackedMarkets", cause }),
    }),
});

export const FileBotStateLive = (store: StateStore): Layer.Layer<BotStatePort> => Layer.succeed(BotState, makeFileBotState(store));
