import { loadConfig } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import { createMainProgram } from "./app/mainEffect.js";
import { provideAppRuntime } from "./app/runtime.js";
import { Effect } from "effect";

const start = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info(
    {
      dryRun: config.dryRun,
    },
    config.dryRun ? "Starting bot in SAFE MODE (DRY_RUN=true)" : "Starting bot in LIVE MODE",
  );

  await Effect.runPromise(provideAppRuntime(createMainProgram({ config, logger })));
};

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
