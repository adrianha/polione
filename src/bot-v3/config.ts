import type { BotConfig } from "../types/domain.js";
import type { V3Config } from "./types.js";

export const createV3Config = (config: BotConfig): V3Config => {
  const resolved: V3Config = {
    marketSlugPrefix: config.v3MarketSlugPrefix ?? "sol-updown-5m",
    marketIntervalSeconds: config.v3MarketIntervalSeconds ?? 300,
    entryThreshold: config.v3EntryThreshold ?? 0.85,
    takeProfitPrice: config.v3TakeProfitPrice ?? 0.95,
    stopLossPrice: config.v3StopLossPrice ?? 0.75,
    orderSize: config.v3OrderSize ?? 5,
    maxEntryAsk: config.v3MaxEntryAsk ?? 0.9,
    maxLivePositions: config.v3MaxLivePositions ?? 1,
    loopIntervalSeconds: config.v3LoopIntervalSeconds ?? 2,
    orderFillTimeoutMs: config.v3OrderFillTimeoutMs ?? 10_000,
    orderFillPollIntervalMs: config.v3OrderFillPollIntervalMs ?? 1_000,
    stateFilePath: config.v3StateFilePath ?? ".bot-v3-state.json",
  };

  if (resolved.takeProfitPrice <= resolved.stopLossPrice) {
    throw new Error("V3 take-profit price must be greater than stop-loss price");
  }
  if (resolved.entryThreshold <= resolved.stopLossPrice) {
    throw new Error("V3 entry threshold must be greater than stop-loss price");
  }
  if (resolved.maxEntryAsk < resolved.entryThreshold) {
    throw new Error("V3 max entry ask must be at least the entry threshold");
  }

  return resolved;
};
