import pino from "pino";
import type { BotConfig } from "../types/domain.js";

export const createLogger = (config: BotConfig) => {
  return pino({
    level: config.logLevel,
    base: {
      service: "polione",
      dryRun: config.dryRun
    }
  });
};
