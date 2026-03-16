import type { RedeemStateRecord, RedeemTerminalReason, RelayerSkippedResult } from "../types/domain.js";
import type { BotDomainContext } from "./botContext.js";
type RedeemPrecheckResult = {
  status:
    | "ok"
    | "not_resolved"
    | "no_redeemable_balance"
    | "permanent_error"
    | "retryable_error";
  reason?: string;
};

const defaultRedeemState = (nowMs: number): RedeemStateRecord => {
  return {
    status: "pending",
    attempts: 0,
    nextRetryAtMs: nowMs,
    updatedAtMs: nowMs,
  };
};

const getRedeemState = (bot: BotDomainContext, conditionId: string): RedeemStateRecord => {
  const existing = bot.redeemStates.get(conditionId);
  if (existing) {
    return existing;
  }

  const state = defaultRedeemState(Date.now());
  bot.redeemStates.set(conditionId, state);
  return state;
};

const setRedeemState = (bot: BotDomainContext, conditionId: string, next: RedeemStateRecord): void => {
  bot.redeemStates.set(conditionId, next);
};

const persistRedeemStates = async (bot: BotDomainContext): Promise<void> => {
  try {
    await bot.stateStore.saveRedeemStates(bot.redeemStates);
  } catch (error) {
    bot.logger.error(
      {
        error,
        stateFilePath: bot.config.stateFilePath,
      },
      "Failed to persist redeem states",
    );
    await bot.notifyOperationalIssue({
      title: "Failed to persist redeem states",
      severity: "error",
      dedupeKey: `persist-redeem-states:${bot.config.stateFilePath}`,
      error,
      details: [{ key: "stateFilePath", value: bot.config.stateFilePath }],
    });
  }
};

const pruneRedeemStates = (bot: BotDomainContext, nowMs: number): number => {
  let removed = 0;
  for (const [conditionId, state] of bot.redeemStates.entries()) {
    if (state.status !== "terminal") {
      continue;
    }

    const ageMs = nowMs - state.updatedAtMs;
    if (ageMs >= bot.config.redeemTerminalStateTtlMs) {
      bot.redeemStates.delete(conditionId);
      removed += 1;
    }
  }
  return removed;
};

const transitionRedeemState = (
  bot: BotDomainContext,
  params: {
    conditionId: string;
    status?: RedeemStateRecord["status"];
    attempts?: number;
    nextRetryAtMs?: number;
    lastError?: string;
    terminalReason?: RedeemTerminalReason;
  },
): RedeemStateRecord => {
  const previous = getRedeemState(bot, params.conditionId);
  const next: RedeemStateRecord = {
    status: params.status ?? previous.status,
    attempts: params.attempts ?? previous.attempts,
    nextRetryAtMs: params.nextRetryAtMs ?? previous.nextRetryAtMs,
    updatedAtMs: Date.now(),
    lastError: params.lastError ?? previous.lastError,
    terminalReason: params.terminalReason ?? previous.terminalReason,
  };
  setRedeemState(bot, params.conditionId, next);
  return next;
};

const scheduleRedeemRetry = (
  bot: BotDomainContext,
  params: {
    conditionId: string;
    reason: string;
    retryAtMs?: number;
    incrementAttempt?: boolean;
  },
): RedeemStateRecord => {
  const current = getRedeemState(bot, params.conditionId);
  const attempts = params.incrementAttempt ? current.attempts + 1 : current.attempts;
  if (attempts >= bot.config.redeemMaxRetries) {
    return transitionRedeemState(bot, {
      conditionId: params.conditionId,
      status: "terminal",
      attempts,
      nextRetryAtMs: Date.now(),
      lastError: params.reason,
      terminalReason: "max_retries_exhausted",
    });
  }

  const retryAtMs = params.retryAtMs ?? Date.now() + Math.max(bot.config.redeemRetryBackoffMs, 1000);
  return transitionRedeemState(bot, {
    conditionId: params.conditionId,
    status: "pending",
    attempts,
    nextRetryAtMs: retryAtMs,
    lastError: params.reason,
  });
};

const markRedeemTerminal = (
  bot: BotDomainContext,
  conditionId: string,
  terminalReason: RedeemTerminalReason,
  lastError?: string,
): RedeemStateRecord => {
  return transitionRedeemState(bot, {
    conditionId,
    status: "terminal",
    nextRetryAtMs:
      Date.now() + (terminalReason === "success" ? bot.config.redeemSuccessCooldownMs : 0),
    terminalReason,
    lastError,
  });
};

const shouldAttemptRedeem = (bot: BotDomainContext, conditionId: string, nowMs: number): boolean => {
  const state = getRedeemState(bot, conditionId);
  if (state.status === "terminal") {
    return false;
  }
  if (state.attempts >= bot.config.redeemMaxRetries) {
    markRedeemTerminal(
      bot,
      conditionId,
      "max_retries_exhausted",
      state.lastError ?? "Retry budget exhausted",
    );
    return false;
  }
  return nowMs >= state.nextRetryAtMs;
};

const isRelayerSkippedResult = (value: unknown): value is RelayerSkippedResult => {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { skipped?: unknown }).skipped === true &&
      typeof (value as { reason?: unknown }).reason === "string",
  );
};

export const processRedeemablePositions = async (
  bot: BotDomainContext,
  positionsAddress: string,
): Promise<void> => {
  if (!bot.config.redeemEnabled || !bot.relayerClient.isAvailable()) {
    return;
  }

  const nowMs = Date.now();
  const prunedTerminalStates = pruneRedeemStates(bot, nowMs);
  let eligibleCount = 0;
  let submittedCount = 0;
  let successCount = 0;
  let skippedRateLimitedCount = 0;
  let terminalNoBalanceCount = 0;
  let terminalNotResolvedCount = 0;
  let failedRetryableCount = 0;
  let failedTerminalCount = 0;
  let skippedByStateCount = 0;

  const positions = await bot.dataClient.getPositions(positionsAddress);
  const redeemableConditionIds: string[] = Array.from(
    new Set(
      positions
        .filter(
          (position: { redeemable?: boolean; conditionId?: unknown }) =>
            position.redeemable === true && typeof position.conditionId === "string",
        )
        .map((position: { conditionId: string }) => position.conditionId)
        .filter((conditionId: string) => conditionId.length > 0),
    ),
  );

  if (redeemableConditionIds.length === 0) {
    return;
  }

  const candidates = redeemableConditionIds.slice(0, bot.config.redeemMaxPerLoop);
  for (const conditionId of candidates) {
    if (!shouldAttemptRedeem(bot, conditionId, nowMs)) {
      skippedByStateCount += 1;
      continue;
    }
    eligibleCount += 1;

    const locked = await bot.withConditionLock(conditionId, async () => {
      const precheck = (await bot.redeemPrecheckService.check({
        conditionId,
        positionsAddress: positionsAddress as `0x${string}`,
      })) as RedeemPrecheckResult;

      if (precheck.status === "not_resolved") {
        terminalNotResolvedCount += 1;
        scheduleRedeemRetry(bot, {
          conditionId,
          reason: precheck.reason ?? "Condition not resolved yet",
        });
        return;
      }

      if (precheck.status === "no_redeemable_balance") {
        terminalNoBalanceCount += 1;
        markRedeemTerminal(
          bot,
          conditionId,
          "already_redeemed",
          precheck.reason ?? "No redeemable balance",
        );
        return;
      }

      if (precheck.status === "permanent_error") {
        failedTerminalCount += 1;
        markRedeemTerminal(
          bot,
          conditionId,
          "permanent_error",
          precheck.reason ?? "Permanent precheck error",
        );
        return;
      }

      if (precheck.status === "retryable_error") {
        failedRetryableCount += 1;
        scheduleRedeemRetry(bot, {
          conditionId,
          reason: precheck.reason ?? "Retryable precheck error",
          incrementAttempt: true,
        });
        return;
      }

      transitionRedeemState(bot, {
        conditionId,
        status: "submitted",
        attempts: getRedeemState(bot, conditionId).attempts + 1,
        nextRetryAtMs: Date.now(),
        lastError: undefined,
        terminalReason: undefined,
      });

      try {
        const redeem = await bot.settlementService.redeemResolvedPositions(conditionId);
        const relayerMeta = bot.getRelayerMeta(redeem);
        await bot.maybeNotifyRelayerFailover({ action: redeem, conditionId });

        if (isRelayerSkippedResult(redeem) && redeem.reason === "relayer_rate_limited") {
          skippedRateLimitedCount += 1;
          scheduleRedeemRetry(bot, {
            conditionId,
            reason: redeem.reason,
            retryAtMs: redeem.retryAt ?? Date.now() + bot.config.redeemRetryBackoffMs,
          });
          bot.logger.warn(
            {
              conditionId,
              retryAt: redeem.retryAt,
            },
            "Redeem skipped: relayer is rate limited",
          );
          return;
        }

        if (!redeem) {
          failedRetryableCount += 1;
          scheduleRedeemRetry(bot, {
            conditionId,
            reason: "Relayer unavailable or returned null",
            incrementAttempt: true,
          });
          return;
        }

        submittedCount += 1;
        successCount += 1;
        markRedeemTerminal(bot, conditionId, "success");
        bot.logger.debug(
          {
            redeem,
            conditionId,
            relayerBuilder: relayerMeta?.builderLabel,
            relayerFailoverFrom: relayerMeta?.failoverFrom,
          },
          "Redeem flow executed",
        );
        await bot.notify({
          title: "redeemResolvedPositions executed",
          severity: "info",
          dedupeKey: `redeem-success:${conditionId}`,
          conditionId,
          details: [{ key: "builder", value: relayerMeta?.builderLabel }],
        });
      } catch (error) {
        failedRetryableCount += 1;
        const message = bot.normalizeError(error);
        const nextState = scheduleRedeemRetry(bot, {
          conditionId,
          reason: message,
          incrementAttempt: true,
        });
        if (nextState.status === "terminal") {
          failedTerminalCount += 1;
        }

        bot.logger.warn(
          {
            conditionId,
            attempts: nextState.attempts,
            nextRetryAtMs: nextState.nextRetryAtMs,
            error,
          },
          "Redeem attempt failed and was scheduled for retry",
        );
      }
    });

    if (!locked.executed) {
      bot.logger.debug({ conditionId }, "Redeem loop skipped condition: already in flight");
    }
  }

  await persistRedeemStates(bot);
  bot.logger.debug(
    {
      candidates: redeemableConditionIds.length,
      cappedCandidates: candidates.length,
      eligible: eligibleCount,
      submitted: submittedCount,
      success: successCount,
      skippedRateLimited: skippedRateLimitedCount,
      terminalNoBalance: terminalNoBalanceCount,
      terminalNotResolved: terminalNotResolvedCount,
      failedRetryable: failedRetryableCount,
      failedTerminal: failedTerminalCount,
      skippedByState: skippedByStateCount,
      prunedTerminalStates,
    },
    "Redeem loop summary",
  );
};
