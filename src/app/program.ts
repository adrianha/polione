import { Effect } from "effect";
import type { BotConfig } from "../types/domain.js";
import type { Logger } from "pino";
import { createMainProgram } from "./mainEffect.js";
import { provideAppRuntime } from "./runtime.js";

export const AppProgram = (params: { config: BotConfig; logger: Logger }): Effect.Effect<void, never> =>
  provideAppRuntime(createMainProgram(params));
