import { Effect } from "effect";
import type { AppError } from "../app/errors.js";
import type { MarketRecord } from "../types/domain.js";

export interface DiscoveryResult {
  currentMarket: MarketRecord | null;
  nextMarket: MarketRecord | null;
  snapshotUpdatedAtMs: number;
}

export interface DiscoveryRuntime {
  readonly updateSnapshot: () => Promise<void>;
  readonly onError: (error: unknown) => Promise<void>;
  readonly sleep: (seconds: number) => Promise<void>;
  readonly loopSleepSeconds: number;
  readonly isStopped: () => boolean;
}

export const runDiscoveryLoopEffect = (runtime: DiscoveryRuntime): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    while (!runtime.isStopped()) {
      yield* Effect.tryPromise({
        try: () => runtime.updateSnapshot(),
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
        try: () => runtime.sleep(runtime.loopSleepSeconds),
        catch: (error) => error as AppError,
      });
    }
  });
