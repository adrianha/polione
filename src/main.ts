import { loadConfig } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import { PolymarketBot } from "./bot.js";

const start = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info(
    {
      dryRun: config.dryRun,
    },
    config.dryRun ? "Starting bot in SAFE MODE (DRY_RUN=true)" : "Starting bot in LIVE MODE",
  );

  const bot = new PolymarketBot(config, logger);

  const shutdown = (): void => {
    logger.warn("Shutdown signal received");
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.runForever();
};

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
