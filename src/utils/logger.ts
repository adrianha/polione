import pino from "pino";
import type { BotConfig } from "../types/domain.js";

type MarketLogContext = {
  currentMarketSlug?: string;
  nextMarketSlug?: string;
};

const marketLogContext: MarketLogContext = {};

export const setLogMarketContext = (context: {
  currentMarketSlug?: string | null;
  nextMarketSlug?: string | null;
}): void => {
  if (typeof context.currentMarketSlug === "string" && context.currentMarketSlug.length > 0) {
    marketLogContext.currentMarketSlug = context.currentMarketSlug;
  } else {
    delete marketLogContext.currentMarketSlug;
  }

  if (typeof context.nextMarketSlug === "string" && context.nextMarketSlug.length > 0) {
    marketLogContext.nextMarketSlug = context.nextMarketSlug;
  } else {
    delete marketLogContext.nextMarketSlug;
  }
};

export const createLogger = (config: BotConfig) => {
  return pino({
    level: config.logLevel,
    mixin() {
      return marketLogContext;
    },
    base: {
      service: "polione",
      dryRun: config.dryRun,
    },
  });
};
