import { Effect } from "effect";
import type { AppError } from "../app/errors.js";

export interface SupervisorRuntime {
  readonly runDiscovery: () => Promise<void>;
  readonly runCurrentMarket: () => Promise<void>;
  readonly runEntry: () => Promise<void>;
  readonly runTelegram: () => Promise<void>;
}

export const runSupervisorEffect = (runtime: SupervisorRuntime): Effect.Effect<void, AppError> =>
  Effect.all([
    Effect.tryPromise({
      try: () => runtime.runDiscovery(),
      catch: (error) => error as AppError,
    }),
    Effect.tryPromise({
      try: () => runtime.runCurrentMarket(),
      catch: (error) => error as AppError,
    }),
    Effect.tryPromise({
      try: () => runtime.runEntry(),
      catch: (error) => error as AppError,
    }),
    Effect.tryPromise({
      try: () => runtime.runTelegram(),
      catch: (error) => error as AppError,
    }),
  ]).pipe(Effect.asVoid);
