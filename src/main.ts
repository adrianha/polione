import { loadConfig } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import { PolymarketBot } from "./bot.js";
import { PolymarketBotV2 } from "./bot-v2/index.js";
import { PolymarketBotV3 } from "./bot-v3/index.js";

const loadRuntimeMode = (): "v1" | "v2" | "v3" => {
  const raw = process.env.BOT_RUNTIME?.trim().toLowerCase();
  if (raw === "v2") {
    return "v2";
  }
  if (raw === "v3") {
    return "v3";
  }
  return "v1";
};

const start = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger(config);
  const runtimeMode = loadRuntimeMode();

  logger.info(
    {
      dryRun: config.dryRun,
      runtimeMode,
    },
    config.dryRun ? "Starting bot in SAFE MODE (DRY_RUN=true)" : "Starting bot in LIVE MODE",
  );

  const bot =
    runtimeMode === "v2"
      ? new PolymarketBotV2(config, logger)
      : runtimeMode === "v3"
        ? new PolymarketBotV3(config, logger)
        : new PolymarketBot(config, logger);

  const shutdown = (): void => {
    logger.warn("Shutdown signal received");
    bot.stop();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.runForever();
};

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
