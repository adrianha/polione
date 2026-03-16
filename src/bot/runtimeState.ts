import type { ConditionLifecycle, ConditionRuntimeState, RecoveryPlacementRecord } from "./marketFlowTypes.js";
import type { BotDomainContext } from "./botContext.js";

const defaultConditionState = (
  overrides?: Partial<ConditionRuntimeState>,
): ConditionRuntimeState => ({
  tracked: false,
  lifecycle: "new",
  mergeAttempted: false,
  balancedCleanupDone: false,
  balancedChecks: 0,
  placementNotified: false,
  filledNotified: false,
  ...overrides,
});

export const getConditionState = (bot: BotDomainContext, conditionId: string): ConditionRuntimeState => {
  const existing = bot.conditionStates.get(conditionId);
  if (existing) {
    return existing;
  }

  const next = defaultConditionState();
  bot.conditionStates.set(conditionId, next);
  return next;
};

export const patchConditionState = (
  bot: BotDomainContext,
  conditionId: string,
  patch: Partial<ConditionRuntimeState>,
): ConditionRuntimeState => {
  const next: ConditionRuntimeState = {
    ...getConditionState(bot, conditionId),
    ...patch,
  };
  bot.conditionStates.set(conditionId, next);
  return next;
};

export const transitionConditionLifecycle = (
  bot: BotDomainContext,
  conditionId: string,
  lifecycle: ConditionLifecycle,
): void => {
  patchConditionState(bot, conditionId, { lifecycle });
};

export const markTrackedMarket = async (bot: BotDomainContext, conditionId: string): Promise<void> => {
  patchConditionState(bot, conditionId, { tracked: true });
  try {
    await bot.stateStore.saveTrackedMarkets(bot.trackedMarkets);
  } catch (error) {
    bot.logger.error(
      {
        error,
        stateFilePath: bot.config.stateFilePath,
        conditionId,
      },
      "Failed to persist tracked market state",
    );
    await bot.notifyOperationalIssue({
      title: "Failed to persist tracked market",
      severity: "error",
      dedupeKey: `persist-tracked-market:${conditionId}`,
      conditionId,
      error,
      details: [{ key: "stateFilePath", value: bot.config.stateFilePath }],
    });
  }
};

export const loadPersistedTrackedMarkets = async (bot: BotDomainContext): Promise<void> => {
  try {
    const [loadedMarkets, loadedRedeemStates] = await Promise.all([
      bot.stateStore.loadTrackedMarkets(),
      bot.stateStore.loadRedeemStates(),
    ]);
    for (const conditionId of loadedMarkets as Set<string>) {
      patchConditionState(bot, conditionId, { tracked: true });
    }
    for (const [conditionId, state] of loadedRedeemStates.entries()) {
      bot.redeemStates.set(conditionId, state);
    }
  } catch (error) {
    bot.logger.error(
      {
        error,
        stateFilePath: bot.config.stateFilePath,
      },
      "Failed to load persisted bot state",
    );
    await bot.notifyOperationalIssue({
      title: "Failed to load persisted bot state",
      severity: "error",
      dedupeKey: `load-bot-state:${bot.config.stateFilePath}`,
      error,
      details: [{ key: "stateFilePath", value: bot.config.stateFilePath }],
    });
  }
};

export const createTrackedMarketsFacade = (bot: BotDomainContext): Set<string> => {
  const facade = {
    has(conditionId: string): boolean {
      return Boolean(bot.conditionStates.get(conditionId)?.tracked);
    },
    add(conditionId: string) {
      patchConditionState(bot, conditionId, { tracked: true });
      return facade;
    },
    delete(conditionId: string): boolean {
      const state = bot.conditionStates.get(conditionId);
      if (!state?.tracked) {
        return false;
      }
      patchConditionState(bot, conditionId, { tracked: false });
      return true;
    },
    clear(): void {
      for (const [conditionId, state] of bot.conditionStates.entries()) {
        if (state.tracked) {
          patchConditionState(bot, conditionId, { tracked: false });
        }
      }
    },
    get size(): number {
      let count = 0;
      for (const state of bot.conditionStates.values()) {
        if (state.tracked) {
          count += 1;
        }
      }
      return count;
    },
    *values() {
      for (const [conditionId, state] of bot.conditionStates.entries()) {
        if (state.tracked) {
          yield conditionId;
        }
      }
      return undefined;
    },
    keys() {
      return facade.values();
    },
    *entries() {
      for (const value of facade.values()) {
        yield [value, value] as [string, string];
      }
      return undefined;
    },
    forEach(callbackfn: (value: string, value2: string, set: Set<string>) => void, thisArg?: unknown): void {
      for (const value of facade.values()) {
        callbackfn.call(thisArg, value, value, facade);
      }
    },
    [Symbol.iterator]() {
      return facade.values();
    },
    [Symbol.toStringTag]: "Set",
  };

  return facade as unknown as Set<string>;
};

export const createRecoveryPlacementsFacade = (bot: BotDomainContext): Map<string, RecoveryPlacementRecord> => {
  const facade = {
    has(conditionId: string): boolean {
      return bot.conditionStates.get(conditionId)?.recoveryPlacement !== undefined;
    },
    get(conditionId: string): RecoveryPlacementRecord | undefined {
      return bot.conditionStates.get(conditionId)?.recoveryPlacement;
    },
    set(conditionId: string, value: RecoveryPlacementRecord) {
      patchConditionState(bot, conditionId, { recoveryPlacement: value });
      return facade;
    },
    delete(conditionId: string): boolean {
      const state = bot.conditionStates.get(conditionId);
      if (!state?.recoveryPlacement) {
        return false;
      }
      patchConditionState(bot, conditionId, { recoveryPlacement: undefined });
      return true;
    },
    clear(): void {
      for (const [conditionId, state] of bot.conditionStates.entries()) {
        if (state.recoveryPlacement !== undefined) {
          patchConditionState(bot, conditionId, { recoveryPlacement: undefined });
        }
      }
    },
    get size(): number {
      let count = 0;
      for (const state of bot.conditionStates.values()) {
        if (state.recoveryPlacement !== undefined) {
          count += 1;
        }
      }
      return count;
    },
    *entries() {
      for (const [conditionId, state] of bot.conditionStates.entries()) {
        if (state.recoveryPlacement !== undefined) {
          yield [conditionId, state.recoveryPlacement] as [string, RecoveryPlacementRecord];
        }
      }
      return undefined;
    },
    *keys() {
      for (const [conditionId] of facade.entries()) {
        yield conditionId;
      }
      return undefined;
    },
    *values() {
      for (const [, value] of facade.entries()) {
        yield value;
      }
      return undefined;
    },
    forEach(
      callbackfn: (value: RecoveryPlacementRecord, key: string, map: Map<string, RecoveryPlacementRecord>) => void,
      thisArg?: unknown,
    ): void {
      for (const [key, value] of facade.entries()) {
        callbackfn.call(thisArg, value, key, facade);
      }
    },
    [Symbol.iterator]() {
      return facade.entries();
    },
    [Symbol.toStringTag]: "Map",
  };

  return facade as unknown as Map<string, RecoveryPlacementRecord>;
};
