import { Effect, Layer, Logger } from "effect";

const baseLayer = Logger.pretty;

export const AppRuntimeLayer = Layer.mergeAll(baseLayer);

export const provideAppRuntime = <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provide(program, AppRuntimeLayer);
