import { Effect } from "effect";
import type { AppError } from "../app/errors.js";

export interface CurrentMarketRuntime {
  readonly isStopped: () => boolean;
  readonly isSnapshotStale: () => boolean;
  readonly getSnapshotAgeMs: () => number | null;
  readonly sleep: (seconds: number) => Promise<void>;
  readonly currentLoopSleepSeconds: number;
  readonly getCurrentMarketConditionId: () => string | null;
  readonly isTrackedCondition: (conditionId: string) => boolean;
  readonly withConditionLock: (conditionId: string, run: () => Promise<void>) => Promise<{ executed: boolean }>;
  readonly processTrackedCurrentMarket: () => Promise<void>;
  readonly onDebug: (message: string, context?: Record<string, unknown>) => Promise<void>;
  readonly onWarn: (message: string, context?: Record<string, unknown>) => Promise<void>;
  readonly onError: (error: unknown) => Promise<void>;
}

export const runCurrentMarketLoopEffect = (runtime: CurrentMarketRuntime): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    while (!runtime.isStopped()) {
      yield* Effect.tryPromise({
        try: async () => {
          if (runtime.isSnapshotStale()) {
            await runtime.onWarn("Current market loop skipped: stale market snapshot", {
              snapshotAgeMs: runtime.getSnapshotAgeMs(),
            });
            await runtime.sleep(runtime.currentLoopSleepSeconds);
            return;
          }

          const currentConditionId = runtime.getCurrentMarketConditionId();
          if (currentConditionId && runtime.isTrackedCondition(currentConditionId)) {
            const locked = await runtime.withConditionLock(currentConditionId, async () => {
              await runtime.processTrackedCurrentMarket();
            });

            if (!locked.executed) {
              await runtime.onDebug("Current market loop skipped: condition already in flight", {
                conditionId: currentConditionId,
              });
            }
          }
        },
        catch: (error) => error as AppError,
      }).pipe(
        Effect.catchAll((error) =>
          Effect.tryPromise({
            try: () => runtime.onError(error),
            catch: (inner) => inner as AppError,
          }),
        ),
      );

      yield* Effect.tryPromise({
        try: () => runtime.sleep(runtime.currentLoopSleepSeconds),
        catch: (error) => error as AppError,
      });
    }
  });
