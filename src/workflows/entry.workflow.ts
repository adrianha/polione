import { Effect } from "effect";
import type { AppError } from "../app/errors.js";

export interface EntryLoopRuntime {
  readonly isStopped: () => boolean;
  readonly isSnapshotStale: () => boolean;
  readonly getSnapshotAgeMs: () => number | null;
  readonly loopSleepSeconds: number;
  readonly sleep: (seconds: number) => Promise<void>;
  readonly resolveEntryConditionId: () => string | null;
  readonly processEntry: () => Promise<number>;
  readonly withConditionLock: (conditionId: string, run: () => Promise<number>) => Promise<{ executed: boolean; result?: number }>;
  readonly onDebug: (message: string, context?: Record<string, unknown>) => Promise<void>;
  readonly onWarn: (message: string, context?: Record<string, unknown>) => Promise<void>;
  readonly onError: (error: unknown) => Promise<void>;
}

export const runEntryLoopEffect = (runtime: EntryLoopRuntime): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    while (!runtime.isStopped()) {
      let sleepSeconds = runtime.loopSleepSeconds;

      sleepSeconds = yield* Effect.tryPromise({
        try: async () => {
          if (runtime.isSnapshotStale()) {
            await runtime.onWarn("Entry loop skipped: stale market snapshot", {
              snapshotAgeMs: runtime.getSnapshotAgeMs(),
            });
            await runtime.sleep(runtime.loopSleepSeconds);
            return runtime.loopSleepSeconds;
          }

          const entryConditionId = runtime.resolveEntryConditionId();
          if (!entryConditionId) {
            return runtime.processEntry();
          }

          const locked = await runtime.withConditionLock(entryConditionId, runtime.processEntry);
          if (!locked.executed) {
            await runtime.onDebug("Entry loop skipped: condition already in flight", {
              conditionId: entryConditionId,
            });
            return runtime.loopSleepSeconds;
          }

          return locked.result ?? runtime.loopSleepSeconds;
        },
        catch: (error) => error as AppError,
      }).pipe(
        Effect.catchAll((error) =>
          Effect.tryPromise({
            try: async () => {
              await runtime.onError(error);
              return runtime.loopSleepSeconds;
            },
            catch: (inner) => inner as AppError,
          }),
        ),
      );

      yield* Effect.tryPromise({
        try: () => runtime.sleep(sleepSeconds),
        catch: (error) => error as AppError,
      });
    }
  });
