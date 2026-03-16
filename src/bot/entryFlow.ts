import { summarizePositions } from "../services/positionManager.js";
import type { MarketRecord } from "../types/domain.js";
import type { BotDomainContext } from "./botContext.js";
import type { EntryOpportunityResult, MarketContext } from "./marketFlowTypes.js";
import { getConditionBuyCapacity } from "./recoveryMath.js";

export const selectEntryMarket = (bot: BotDomainContext, params: MarketContext): MarketRecord | null => {
  const { currentMarket, nextMarket, currentConditionId } = params;

  if (nextMarket) {
    const nextConditionId = bot.marketDiscovery.getConditionId(nextMarket);
    if (!currentConditionId || nextConditionId !== currentConditionId) {
      return nextMarket;
    }
  }

  return currentMarket;
};

export const processEntryMarket = async (
  bot: BotDomainContext,
  params: {
    entryMarket: MarketRecord;
    currentConditionId: string | null;
    positionsAddress: string;
  },
): Promise<EntryOpportunityResult> => {
  const { entryMarket, currentConditionId, positionsAddress } = params;

  const entryTokenIds = bot.marketDiscovery.getTokenIds(entryMarket);
  if (!entryTokenIds) {
    bot.logger.warn({ slug: entryMarket.slug }, "Entry market found but no token IDs");
    await bot.notifyOperationalIssue({
      title: "Entry market missing token IDs",
      severity: "warn",
      dedupeKey: `entry-market-missing-token-ids:${entryMarket.slug}`,
      slug: entryMarket.slug,
    });
    return { outcome: "failed", secondsToClose: null };
  }

  const entryConditionId = bot.marketDiscovery.getConditionId(entryMarket);
  if (!entryConditionId) {
    bot.logger.warn({ slug: entryMarket.slug }, "Entry market missing condition ID");
    await bot.notifyOperationalIssue({
      title: "Entry market missing condition ID",
      severity: "warn",
      dedupeKey: `entry-market-missing-condition-id:${entryMarket.slug}`,
      slug: entryMarket.slug,
    });
    return { outcome: "failed", secondsToClose: null };
  }

  bot.logger.debug(
    {
      slug: entryMarket.slug,
      conditionId: entryConditionId,
      upTokenId: entryTokenIds.upTokenId,
      downTokenId: entryTokenIds.downTokenId,
    },
    "Evaluating entry market",
  );

  const existingPositions = await bot.dataClient.getPositions(positionsAddress, entryConditionId);
  const existingSummary = summarizePositions(existingPositions, entryTokenIds);
  const buyCapacity = getConditionBuyCapacity(bot.config, existingSummary);
  if (buyCapacity.hasAnyExposure) {
    bot.logger.warn(
      {
        conditionId: entryConditionId,
        slug: entryMarket.slug,
        up: existingSummary.upSize,
        down: existingSummary.downSize,
        diff: existingSummary.differenceAbs,
        orderSizeCap: bot.config.orderSize,
        reachedCap: buyCapacity.reachedCap,
        remainingUp: buyCapacity.remainingUp,
        remainingDown: buyCapacity.remainingDown,
      },
      "Skipped paired entry: existing exposure detected; handed off to tracked-market recovery",
    );
    await bot.markTrackedMarket(entryConditionId);
    bot.transitionConditionLifecycle(entryConditionId, "recovery-pending");
    return {
      outcome: "recovery-needed",
      conditionId: entryConditionId,
      secondsToClose: null,
    };
  }

  if (bot.trackedMarkets.has(entryConditionId)) {
    bot.logger.debug(
      {
        conditionId: entryConditionId,
        slug: entryMarket.slug,
      },
      "Skipped new entry: market already tracked",
    );
    return { outcome: "idle", conditionId: entryConditionId, secondsToClose: null };
  }

  const requiredUsdcForBothLegs = bot.config.orderPrice * bot.config.orderSize * 2;
  const currentUsdcBalance = await bot.clobClient.getUsdcBalance();
  if (currentUsdcBalance < requiredUsdcForBothLegs) {
    bot.logger.debug(
      {
        conditionId: entryConditionId,
        slug: entryMarket.slug,
        usdcBalance: currentUsdcBalance,
        requiredUsdc: requiredUsdcForBothLegs,
      },
      "Skipped new entry: insufficient USDC balance for both legs",
    );
    return { outcome: "idle", conditionId: entryConditionId, secondsToClose: null };
  }

  const isCurrentMarketEntry = currentConditionId !== null && entryConditionId === currentConditionId;
  const secondsToClose = isCurrentMarketEntry
    ? bot.marketDiscovery.getSecondsToMarketClose(entryMarket)
    : null;
  const isInsideForceSellWindow =
    isCurrentMarketEntry &&
    secondsToClose !== null &&
    secondsToClose <= bot.config.forceSellThresholdSeconds;

  if (!isCurrentMarketEntry) {
    bot.transitionConditionLifecycle(entryConditionId, "entry-pending");
    const entryPrice = bot.config.orderPrice;
    const paired = await bot.tradingEngine.placePairedLimitBuysAtPrice(
      entryTokenIds,
      entryPrice,
      bot.config.orderSize,
    );
    bot.logger.info(
      {
        paired,
        conditionId: entryConditionId,
        entryPrice,
        orderSize: bot.config.orderSize,
      },
      "Placed paired limit buy orders for non-current market; liquidity gate bypassed",
    );
    await bot.notifyPlacementSuccessOnce({
      conditionId: entryConditionId,
      slug: entryMarket.slug,
      upTokenId: entryTokenIds.upTokenId,
      downTokenId: entryTokenIds.downTokenId,
      entryPrice,
      orderSize: bot.config.orderSize,
      attempt: 0,
      mode: "non-current-market",
    });
    await bot.markTrackedMarket(entryConditionId);
    bot.transitionConditionLifecycle(entryConditionId, "entry-pending");
    bot.logger.info(
      {
        conditionId: entryConditionId,
        slug: entryMarket.slug,
      },
      "Deferred recovery for non-current market until it becomes current",
    );
    return {
      outcome: "entered",
      conditionId: entryConditionId,
      secondsToClose: null,
    };
  }

  const entryPrice = bot.config.orderPrice;
  bot.transitionConditionLifecycle(
    entryConditionId,
    isInsideForceSellWindow ? "force-window" : "entry-pending",
  );

  const paired = await bot.tradingEngine.placePairedLimitBuysAtPrice(
    entryTokenIds,
    entryPrice,
    bot.config.orderSize,
  );
  bot.logger.info(
    {
      paired,
      conditionId: entryConditionId,
      entryPrice,
      orderSize: bot.config.orderSize,
      secondsToClose,
      forceSellWindow: isInsideForceSellWindow,
    },
    "Placed paired limit buy orders",
  );
  await bot.notifyPlacementSuccessOnce({
    conditionId: entryConditionId,
    slug: entryMarket.slug,
    upTokenId: entryTokenIds.upTokenId,
    downTokenId: entryTokenIds.downTokenId,
    entryPrice,
    orderSize: bot.config.orderSize,
    attempt: 0,
    secondsToClose,
    mode: "current-market",
  });

  const reconcile = await bot.tradingEngine.reconcilePairedEntry({
    positionsAddress,
    conditionId: entryConditionId,
    tokenIds: entryTokenIds,
    cancelOpenOrders: !isInsideForceSellWindow,
  });

  if (isInsideForceSellWindow && reconcile.status === "imbalanced") {
    const recovery = await bot.handleForceWindowImbalance({
      market: entryMarket,
      conditionId: entryConditionId,
      positionsAddress,
      tokenIds: entryTokenIds,
      summary: reconcile.finalSummary,
      secondsToClose,
      entryPrice,
    });

    if (recovery.status === "balanced") {
      await bot.cancelEntryOrdersAfterBalance(entryTokenIds, {
        conditionId: entryConditionId,
        path: "entry-market:force-window",
      });
      await bot.markTrackedMarket(entryConditionId);
      return {
        outcome: "balanced",
        conditionId: entryConditionId,
        secondsToClose,
      };
    }

    return {
      outcome: "force-window",
      conditionId: entryConditionId,
      secondsToClose,
    };
  }

  if (reconcile.status === "balanced") {
    await bot.cancelEntryOrdersAfterBalance(entryTokenIds, {
      conditionId: entryConditionId,
      path: "entry-market:reconcile",
    });
    await bot.notifyEntryFilledOnce({
      conditionId: entryConditionId,
      slug: entryMarket.slug,
      upTokenId: entryTokenIds.upTokenId,
      downTokenId: entryTokenIds.downTokenId,
      upSize: reconcile.finalSummary.upSize,
      downSize: reconcile.finalSummary.downSize,
      entryPrice,
      mode: "reconcile",
    });
    await bot.markTrackedMarket(entryConditionId);
    bot.transitionConditionLifecycle(entryConditionId, "balanced");
    bot.logger.info(
      {
        conditionId: entryConditionId,
        status: reconcile.status,
        attempts: reconcile.attempts,
        summary: reconcile.finalSummary,
        entryPrice,
      },
      "Entry reconciliation succeeded",
    );
    return {
      outcome: "balanced",
      conditionId: entryConditionId,
      secondsToClose,
    };
  }

  if (reconcile.status === "imbalanced") {
    let handoffCancelledOpenOrders: unknown[] | undefined;
    try {
      handoffCancelledOpenOrders = await bot.tradingEngine.cancelEntryOpenOrders(entryTokenIds);
    } catch (error) {
      bot.logger.warn(
        {
          conditionId: entryConditionId,
          error,
          path: "entry-market:imbalance-handoff-cancel",
        },
        "Failed to immediately cancel paired entry orders during recovery handoff",
      );
    }

    await bot.markTrackedMarket(entryConditionId);
    bot.transitionConditionLifecycle(
      entryConditionId,
      isInsideForceSellWindow ? "force-window" : "recovery-pending",
    );
    bot.logger.warn(
      {
        conditionId: entryConditionId,
        status: reconcile.status,
        attempts: reconcile.attempts,
        summary: reconcile.finalSummary,
        cancelledOpenOrders: reconcile.cancelledOpenOrders,
        reason: reconcile.reason,
        entryPrice,
        secondsToClose,
        forceSellWindow: isInsideForceSellWindow,
        handoff: "tracked-market-recovery",
        handoffCancelledOpenOrders,
      },
      "Entry reconciliation detected partial fill; cancelled paired orders and handed off to tracked-market recovery",
    );
    await bot.notify({
      title: "Entry remains imbalanced",
      severity: "warn",
      dedupeKey: `reconcile-imbalanced:${entryConditionId}`,
      slug: entryMarket.slug,
      conditionId: entryConditionId,
      upTokenId: entryTokenIds.upTokenId,
      downTokenId: entryTokenIds.downTokenId,
      details: [
        { key: "attempt", value: 0 },
        { key: "entryPrice", value: entryPrice },
        { key: "up", value: reconcile.finalSummary.upSize },
        { key: "down", value: reconcile.finalSummary.downSize },
        { key: "diff", value: reconcile.finalSummary.differenceAbs },
        { key: "reason", value: reconcile.reason },
        { key: "secondsToClose", value: secondsToClose },
      ],
    });
    return {
      outcome: isInsideForceSellWindow ? "force-window" : "recovery-needed",
      conditionId: entryConditionId,
      secondsToClose,
    };
  }

  bot.transitionConditionLifecycle(entryConditionId, "terminal");
  bot.logger.error(
    {
      conditionId: entryConditionId,
      status: reconcile.status,
      attempts: reconcile.attempts,
      summary: reconcile.finalSummary,
      cancelledOpenOrders: reconcile.cancelledOpenOrders,
      reason: reconcile.reason,
      entryPrice,
    },
    "Entry reconciliation failed",
  );
  await bot.notify({
    title: "Entry reconciliation failed",
    severity: "error",
    dedupeKey: `reconcile-failed:${entryConditionId}`,
    slug: entryMarket.slug,
    conditionId: entryConditionId,
    upTokenId: entryTokenIds.upTokenId,
    downTokenId: entryTokenIds.downTokenId,
    details: [
      { key: "attempt", value: 0 },
      { key: "entryPrice", value: entryPrice },
      { key: "up", value: reconcile.finalSummary.upSize },
      { key: "down", value: reconcile.finalSummary.downSize },
      { key: "diff", value: reconcile.finalSummary.differenceAbs },
      { key: "reason", value: reconcile.reason },
      { key: "secondsToClose", value: secondsToClose },
    ],
  });

  return {
    outcome: "failed",
    conditionId: entryConditionId,
    secondsToClose,
  };
};
