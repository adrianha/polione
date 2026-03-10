import { Effect } from "effect";

export const AppProgram = Effect.gen(function* () {
  yield* Effect.logInfo("Effect runtime initialized");
});
