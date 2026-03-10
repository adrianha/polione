import { Effect } from "effect";
import type { BotConfig } from "../types/domain.js";
import type { Logger } from "pino";
import { PolymarketBot } from "../bot.js";
import { runSupervisorEffect } from "../workflows/supervisor.workflow.js";

export const createMainProgram = (params: {
  config: BotConfig;
  logger: Logger;
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const bot = new PolymarketBot(params.config, params.logger);

    const shutdown = (): void => {
      params.logger.warn("Shutdown signal received");
      bot.stop();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const initResult = yield* Effect.tryPromise({
      try: async () => bot.init(),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          params.logger.error({ error }, "Bot initialization failed");
          throw error;
        }),
      ),
    );

    yield* runSupervisorEffect({
      runDiscovery: () => bot.runDiscovery(),
      runCurrentMarket: () => bot.runCurrentMarket(initResult.positionsAddress),
      runEntry: () => bot.runEntry(initResult.positionsAddress),
      runTelegram: () => bot.runTelegram(),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          params.logger.error({ error }, "Supervisor workflow failed");
        }),
      ),
    );

    yield* Effect.tryPromise({
      try: async () => bot.finalize(),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          params.logger.error({ error }, "Bot finalization failed");
        }),
      ),
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        params.logger.error({ error }, "Main effect terminated");
      }),
    ),
  );
