import { loadConfig } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import { PolymarketBot } from "./bot.js";
import { PolymarketBotV2 } from "./bot-v2/index.js";
import { PolymarketBotV3 } from "./bot-v3/index.js";
import { PolymarketBotV5, loadV5Config } from "./bot-v5/index.js";

const loadRuntimeMode = (): "v1" | "v2" | "v3" | "v5" => {
  const raw = process.env.BOT_RUNTIME?.trim().toLowerCase();
  if (raw === "v2") {
    return "v2";
  }
  if (raw === "v3") {
    return "v3";
  }
  if (raw === "v5") {
    return "v5";
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

  type Runnable = { stop: () => void; runForever: () => Promise<void> };
  let bot: Runnable;

  if (runtimeMode === "v5") {
    const v5Config = loadV5Config();
    bot = new PolymarketBotV5(config, v5Config, logger);
  } else if (runtimeMode === "v2") {
    bot = new PolymarketBotV2(config, logger);
  } else if (runtimeMode === "v3") {
    bot = new PolymarketBotV3(config, logger);
  } else {
    bot = new PolymarketBot(config, logger);
  }

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
