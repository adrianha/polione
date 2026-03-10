import type { BotConfig } from "../types/domain.js";
import { loadEffectConfig } from "./effectConfig.js";

export const loadConfig = (): BotConfig => loadEffectConfig();
