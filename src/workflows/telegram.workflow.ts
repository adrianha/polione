import { Effect } from "effect";
import type { AppError } from "../app/errors.js";

export interface TelegramLoopRuntime {
  readonly isStopped: () => boolean;
  readonly loopSleepSeconds: number;
  readonly sleep: (seconds: number) => Promise<void>;
  readonly processCommands: () => Promise<void>;
  readonly onWarn: (error: unknown) => Promise<void>;
}

export const runTelegramLoopEffect = (runtime: TelegramLoopRuntime): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    while (!runtime.isStopped()) {
      yield* Effect.tryPromise({
        try: () => runtime.processCommands(),
        catch: (error) => error as AppError,
      }).pipe(
        Effect.catchAll((error) =>
          Effect.tryPromise({
            try: () => runtime.onWarn(error),
            catch: (inner) => inner as AppError,
          }),
        ),
      );

      yield* Effect.tryPromise({
        try: () => runtime.sleep(Math.max(2, runtime.loopSleepSeconds)),
        catch: (error) => error as AppError,
      });
    }
  });
