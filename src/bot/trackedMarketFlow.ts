import { arePositionsEqual, summarizePositions } from "../services/positionManager.js";
import { MarketTokenMismatchError } from "../services/tradingEngine.js";
import type { MarketRecord, PositionSummary, TokenIds } from "../types/domain.js";
import type { BotDomainContext } from "./botContext.js";
import type {
  CurrentMarketResult,
  RecoveryPlacementRecord,
} from "./marketFlowTypes.js";
import {
  MERGE_BALANCE_CONFIRMATION_CHECKS,
  MIN_MARKET_MAKER_ORDER_SIZE,
  computeMakerMissingLegPrice,
  didSummaryChange,
  evaluateForceWindowHedge,
  getConditionBuyCapacity,
  getImbalancePlan,
  getRemainingAllowanceForTokenId,
  getTimeAwareRecoveryPolicy,
  hasAnyFill,
  roundPrice,
} from "./recoveryMath.js";

export const noteCurrentMarketContext = (
  bot: BotDomainContext,
  conditionId: string,
  tokenIds: TokenIds,
): void => {
  if (bot.activeCurrentConditionId === conditionId) {
    bot.activeCurrentTokenIds = tokenIds;
    return;
  }

  const previousTokenIds = bot.activeCurrentTokenIds;
  const previousConditionId = bot.activeCurrentConditionId;
  bot.activeCurrentConditionId = conditionId;
  bot.activeCurrentTokenIds = tokenIds;

  if (!previousConditionId || !previousTokenIds) {
    return;
  }

  bot.recentRecoveryPlacements.delete(previousConditionId);
  bot.logger.debug(
    {
      previousConditionId,
      nextConditionId: conditionId,
    },
    "Cleared stale recovery and quote cache after current-market transition",
  );
};

export const runContinuousMissingLegRecovery = async (
  bot: BotDomainContext,
  params: {
    market: MarketRecord;
    conditionId: string;
    positionsAddress: string;
    tokenIds: TokenIds;
    currentSummary: PositionSummary;
    filledLegAvgPrice: number;
    previousPlacement?: RecoveryPlacementRecord;
  },
): Promise<{
  status: "balanced" | "placed" | "unchanged-price" | "timeout" | "force-window" | "not-applicable";
  finalSummary: PositionSummary;
  lastPlacedPrice?: number;
  missingLegTokenId?: string;
  placedSize?: number;
  orderId?: string | null;
  iterations: number;
  reason?: string;
}> => {
  const initialImbalance = getImbalancePlan(params.currentSummary, params.tokenIds);
  if (!initialImbalance) {
    return {
      status: "not-applicable",
      finalSummary: params.currentSummary,
      iterations: 0,
      reason: "Initial position is not imbalanced",
    };
  }

  if (!bot.config.entryContinuousRepriceEnabled) {
    return {
      status: "timeout",
      finalSummary: params.currentSummary,
      iterations: 0,
      reason: "Continuous repricing disabled",
    };
  }

  const iterations = 1;
  const secondsToClose = bot.marketDiscovery.getSecondsToMarketClose(params.market);
  if (secondsToClose !== null && secondsToClose <= bot.config.forceSellThresholdSeconds) {
    return {
      status: "force-window",
      finalSummary: params.currentSummary,
      iterations,
      reason: "Reached force-sell window during missing-leg recovery",
    };
  }

  const recoveryPolicy = getTimeAwareRecoveryPolicy(bot.config, secondsToClose);
  let latestSummary = params.currentSummary;
  let buyCapacity = getConditionBuyCapacity(bot.config, latestSummary);
  if (buyCapacity.reachedCap) {
    return {
      status: "timeout",
      finalSummary: latestSummary,
      iterations,
      reason: "Strict cap reached; no further buys allowed",
    };
  }

  if (
    latestSummary.upSize > 0 &&
    latestSummary.downSize > 0 &&
    arePositionsEqual(latestSummary, bot.config.positionEqualityTolerance)
  ) {
    return {
      status: "balanced",
      finalSummary: latestSummary,
      iterations,
    };
  }

  const imbalance = getImbalancePlan(latestSummary, params.tokenIds);
  if (!imbalance) {
    return {
      status: "not-applicable",
      finalSummary: latestSummary,
      iterations,
      reason: "Imbalance no longer present",
    };
  }

  let effectiveMissingAmount = imbalance.missingAmount;
  if (
    params.previousPlacement &&
    params.previousPlacement.missingLegTokenId === imbalance.missingLegTokenId
  ) {
    const openBuyCoverage = await bot.tradingEngine.getOpenBuyExposure(imbalance.missingLegTokenId);
    const snapshotLikelyLagging = !didSummaryChange(
      params.previousPlacement.summary,
      latestSummary,
    );

    let matchedButNotReflected = 0;
    if (snapshotLikelyLagging && params.previousPlacement.orderId) {
      const fillState = await bot.tradingEngine.getOrderFillState(params.previousPlacement.orderId);
      matchedButNotReflected = fillState?.matchedSize ?? 0;
    }

    const pendingCoverage = openBuyCoverage + matchedButNotReflected;
    effectiveMissingAmount = Number(
      Math.max(0, imbalance.missingAmount - pendingCoverage).toFixed(6),
    );
    if (effectiveMissingAmount <= 1e-6) {
      return {
        status: "unchanged-price",
        finalSummary: latestSummary,
        iterations,
        lastPlacedPrice: params.previousPlacement.price,
        missingLegTokenId: imbalance.missingLegTokenId,
        reason:
          "Skipped re-order because pending recovery coverage already satisfies missing amount",
      };
    }
  }

  if (!params.previousPlacement) {
    const recheckedPositions = await bot.dataClient
      .getPositions(params.positionsAddress, params.conditionId)
      .catch(() => null);
    if (Array.isArray(recheckedPositions)) {
      latestSummary = summarizePositions(recheckedPositions, params.tokenIds);

      if (
        latestSummary.upSize > 0 &&
        latestSummary.downSize > 0 &&
        arePositionsEqual(latestSummary, bot.config.positionEqualityTolerance)
      ) {
        return {
          status: "balanced",
          finalSummary: latestSummary,
          iterations,
        };
      }

      const recheckedImbalance = getImbalancePlan(latestSummary, params.tokenIds);
      if (
        !recheckedImbalance ||
        recheckedImbalance.missingLegTokenId !== imbalance.missingLegTokenId
      ) {
        return {
          status: "not-applicable",
          finalSummary: latestSummary,
          iterations,
          reason: "Imbalance changed before first missing-leg recovery placement",
        };
      }

      effectiveMissingAmount = Math.min(effectiveMissingAmount, recheckedImbalance.missingAmount);
      buyCapacity = getConditionBuyCapacity(bot.config, latestSummary);
    }
  }

  const targetMinProfitPerShare =
    bot.config.forceWindowMinProfitPerShare + recoveryPolicy.extraProfitBuffer;
  const maxMissingPrice = roundPrice(
    1 - params.filledLegAvgPrice - bot.config.forceWindowFeeBuffer - targetMinProfitPerShare,
  );

  if (maxMissingPrice <= 0) {
    return {
      status: "timeout",
      finalSummary: latestSummary,
      iterations,
      reason: "Missing-leg profitability cap is non-positive",
    };
  }

  let top: {
    bestBid: number;
    bestAsk: number;
    topBids: number[];
    topAsks: number[];
    rawTopBids: number[];
    rawTopAsks: number[];
    priceSource: "sdk";
    sdkBestBid: number;
    sdkBestAsk: number;
  };
  try {
    top = await bot.tradingEngine.getTopOfBookForCondition({
      conditionId: params.conditionId,
      tokenIds: params.tokenIds,
      tokenId: imbalance.missingLegTokenId,
    });
  } catch (error) {
    if (error instanceof MarketTokenMismatchError) {
      bot.logger.warn(
        {
          conditionId: params.conditionId,
          slug: params.market.slug,
          tokenId: imbalance.missingLegTokenId,
          upTokenId: params.tokenIds.upTokenId,
          downTokenId: params.tokenIds.downTokenId,
        },
        "Skipped missing-leg recovery: token is outside current market context",
      );
      await bot.notifyOperationalIssue({
        title: "Skipped missing-leg recovery (market mismatch)",
        severity: "warn",
        dedupeKey: `market-token-mismatch:recovery:${params.conditionId}:${imbalance.missingLegTokenId}`,
        slug: params.market.slug,
        conditionId: params.conditionId,
        upTokenId: params.tokenIds.upTokenId,
        downTokenId: params.tokenIds.downTokenId,
        details: [{ key: "tokenId", value: imbalance.missingLegTokenId }],
      });
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Missing-leg token is not valid for current market condition",
      };
    }
    throw error;
  }

  const topBids = Array.isArray(top.topBids) && top.topBids.length > 0 ? top.topBids : [top.bestBid];
  const topAsks = Array.isArray(top.topAsks) && top.topAsks.length > 0 ? top.topAsks : [top.bestAsk];
  const rawTopBids = Array.isArray(top.rawTopBids) && top.rawTopBids.length > 0 ? top.rawTopBids : topBids;
  const rawTopAsks = Array.isArray(top.rawTopAsks) && top.rawTopAsks.length > 0 ? top.rawTopAsks : topAsks;

  const makerPrice = computeMakerMissingLegPrice({
    config: bot.config,
    bestBid: top.bestBid,
    bestAsk: top.bestAsk,
    maxMissingPrice,
    makerOffset: recoveryPolicy.makerOffset,
  });

  const canCrossBestAsk = top.bestAsk > 0 && top.bestAsk <= maxMissingPrice;
  const nextPrice = canCrossBestAsk ? roundPrice(top.bestAsk) : makerPrice;
  const lowPriceGuardThreshold = 0.05;
  const lowPriceFallbackBuffer = 0.05;
  const fallbackPrice = roundPrice(1 - params.filledLegAvgPrice - lowPriceFallbackBuffer);
  const topBidAnchoredPrice = roundPrice(top.bestBid + recoveryPolicy.makerOffset);
  const anchoredNextPrice = roundPrice(Math.max(nextPrice, topBidAnchoredPrice));
  const guardTriggered = anchoredNextPrice > 0 && anchoredNextPrice < lowPriceGuardThreshold;
  const finalPrice = guardTriggered ? fallbackPrice : anchoredNextPrice;

  if (finalPrice <= 0) {
    return {
      status: "timeout",
      finalSummary: latestSummary,
      iterations,
      reason: "Missing-leg recovery price unavailable",
    };
  }

  let repriceContext:
    | {
        previousPrice: number;
        elapsedMs: number;
        priceDelta: number;
      }
    | undefined;

  if (
    params.previousPlacement &&
    params.previousPlacement.missingLegTokenId === imbalance.missingLegTokenId
  ) {
    const elapsedMs = Date.now() - params.previousPlacement.placedAtMs;
    const priceDelta = Math.abs(finalPrice - params.previousPlacement.price);
    repriceContext = {
      previousPrice: params.previousPlacement.price,
      elapsedMs,
      priceDelta,
    };
    if (
      elapsedMs < bot.config.entryContinuousRepriceIntervalMs &&
      priceDelta < bot.config.entryContinuousMinPriceDelta
    ) {
      return {
        status: "unchanged-price",
        finalSummary: latestSummary,
        iterations,
        lastPlacedPrice: params.previousPlacement.price,
        missingLegTokenId: imbalance.missingLegTokenId,
        reason: "Skipped re-order because min reprice interval and min price delta were not met",
      };
    }

    if (priceDelta < 1e-6) {
      return {
        status: "unchanged-price",
        finalSummary: latestSummary,
        iterations,
        lastPlacedPrice: finalPrice,
        missingLegTokenId: imbalance.missingLegTokenId,
        reason: "Skipped re-order because recovery price is unchanged",
      };
    }
  }

  const expectedLockPnlPerShare =
    1 - params.filledLegAvgPrice - finalPrice - bot.config.forceWindowFeeBuffer;
  if (expectedLockPnlPerShare < targetMinProfitPerShare) {
    return {
      status: "timeout",
      finalSummary: latestSummary,
      iterations,
      lastPlacedPrice: finalPrice,
      missingLegTokenId: imbalance.missingLegTokenId,
      reason: "Missing-leg edge below time-aware profitability target",
    };
  }

  const hasSamePriceOpenRecoveryOrder = await bot.tradingEngine.hasOpenBuyOrderAtPrice(
    imbalance.missingLegTokenId,
    finalPrice,
  );
  if (hasSamePriceOpenRecoveryOrder) {
    return {
      status: "unchanged-price",
      finalSummary: latestSummary,
      iterations,
      lastPlacedPrice: finalPrice,
      missingLegTokenId: imbalance.missingLegTokenId,
      reason: "Skipped re-order because equivalent open recovery order already exists",
    };
  }

  await bot.tradingEngine.cancelEntryOpenOrders(params.tokenIds);
  const remainingForMissingLeg = getRemainingAllowanceForTokenId(
    imbalance.missingLegTokenId,
    params.tokenIds,
    buyCapacity,
  );
  if (remainingForMissingLeg <= bot.config.positionEqualityTolerance) {
    return {
      status: "timeout",
      finalSummary: latestSummary,
      iterations,
      reason: "Strict cap reached on missing leg; no further buys allowed",
    };
  }

  const cappedMissingAmount = Number(
    Math.min(effectiveMissingAmount, remainingForMissingLeg).toFixed(6),
  );
  if (cappedMissingAmount < MIN_MARKET_MAKER_ORDER_SIZE) {
    bot.logger.info(
      {
        conditionId: params.conditionId,
        missingLegTokenId: imbalance.missingLegTokenId,
        effectiveMissingAmount,
        remainingAllowance: remainingForMissingLeg,
        recoveryPolicy,
        cappedMissingAmount,
      },
      "Missing-leg recovery order size below minimum order size; Skipping missing-leg recovery for this cycle.",
    );
    return {
      status: "timeout",
      finalSummary: latestSummary,
      iterations,
      reason: "Missing-leg recovery order size below minimum order size after cap clamp",
    };
  }

  bot.logger.info(
    {
      conditionId: params.conditionId,
      slug: params.market.slug,
      missingLegTokenId: imbalance.missingLegTokenId,
      secondsToClose,
      summary: latestSummary,
      missingAmount: imbalance.missingAmount,
      effectiveMissingAmount,
      remainingForMissingLeg,
      cappedMissingAmount,
      recoveryPolicy,
      filledLegAvgPrice: params.filledLegAvgPrice,
      forceWindowFeeBuffer: bot.config.forceWindowFeeBuffer,
      forceWindowMinProfitPerShare: bot.config.forceWindowMinProfitPerShare,
      targetMinProfitPerShare,
      expectedLockPnlPerShare,
      maxMissingPrice,
      bestBid: top.bestBid,
      bestAsk: top.bestAsk,
      topBids,
      topAsks,
      rawTopBids,
      rawTopAsks,
      priceSource: top.priceSource,
      sdkBestBid: top.sdkBestBid,
      sdkBestAsk: top.sdkBestAsk,
      spread: roundPrice(Math.max(0, top.bestAsk - top.bestBid)),
      makerPrice,
      canCrossBestAsk,
      nextPrice,
      finalPrice,
      lowPriceGuardThreshold,
      lowPriceFallbackBuffer,
      fallbackPrice,
      topBidAnchoredPrice,
      anchoredNextPrice,
      guardTriggered,
      entryContinuousRepriceIntervalMs: bot.config.entryContinuousRepriceIntervalMs,
      entryContinuousMinPriceDelta: bot.config.entryContinuousMinPriceDelta,
      repriceContext,
      action: "placeSingleLimitBuyAtPrice",
      orderPrice: finalPrice,
      orderSize: cappedMissingAmount,
    },
    "Missing-leg recovery placement decision context",
  );
  void bot
    .notify({
      title: "Missing-leg recovery placement decision",
      severity: "info",
      dedupeKey: `missing-leg-recovery-placement:${params.conditionId}:${imbalance.missingLegTokenId}:${finalPrice}:${top.bestBid}:${top.bestAsk}`,
      slug: params.market.slug,
      conditionId: params.conditionId,
      upTokenId: params.tokenIds.upTokenId,
      downTokenId: params.tokenIds.downTokenId,
      details: [
        { key: "missingLegTokenId", value: imbalance.missingLegTokenId },
        { key: "secondsToClose", value: secondsToClose },
        { key: "missingAmount", value: imbalance.missingAmount },
        { key: "effectiveMissingAmount", value: effectiveMissingAmount },
        { key: "remainingForMissingLeg", value: remainingForMissingLeg },
        { key: "cappedMissingAmount", value: cappedMissingAmount },
        { key: "filledLegAvgPrice", value: params.filledLegAvgPrice },
        { key: "targetMinProfitPerShare", value: targetMinProfitPerShare },
        { key: "expectedLockPnlPerShare", value: expectedLockPnlPerShare },
        { key: "maxMissingPrice", value: maxMissingPrice },
        { key: "bestBid", value: top.bestBid },
        { key: "bestAsk", value: top.bestAsk },
        { key: "priceSource", value: top.priceSource },
        { key: "sdkBestBid", value: top.sdkBestBid },
        { key: "sdkBestAsk", value: top.sdkBestAsk },
        { key: "rawBid1", value: rawTopBids[0] },
        { key: "rawBid2", value: rawTopBids[1] },
        { key: "rawBid3", value: rawTopBids[2] },
        { key: "rawAsk1", value: rawTopAsks[0] },
        { key: "rawAsk2", value: rawTopAsks[1] },
        { key: "rawAsk3", value: rawTopAsks[2] },
        { key: "bid1", value: topBids[0] },
        { key: "bid2", value: topBids[1] },
        { key: "bid3", value: topBids[2] },
        { key: "ask1", value: topAsks[0] },
        { key: "ask2", value: topAsks[1] },
        { key: "ask3", value: topAsks[2] },
        { key: "spread", value: roundPrice(Math.max(0, top.bestAsk - top.bestBid)) },
        { key: "makerPrice", value: makerPrice },
        { key: "canCrossBestAsk", value: canCrossBestAsk ? "yes" : "no" },
        { key: "nextPrice", value: nextPrice },
        { key: "finalPrice", value: finalPrice },
        { key: "guardTriggered", value: guardTriggered ? "yes" : "no" },
        { key: "guardThreshold", value: lowPriceGuardThreshold },
        { key: "fallbackBuffer", value: lowPriceFallbackBuffer },
        { key: "fallbackPrice", value: fallbackPrice },
        { key: "topBidAnchoredPrice", value: topBidAnchoredPrice },
        { key: "anchoredNextPrice", value: anchoredNextPrice },
        { key: "previousPrice", value: repriceContext?.previousPrice },
        { key: "priceDelta", value: repriceContext?.priceDelta },
        { key: "elapsedMs", value: repriceContext?.elapsedMs },
        { key: "orderPrice", value: finalPrice },
        { key: "orderSize", value: cappedMissingAmount },
      ],
    })
    .catch((error: unknown) => {
      bot.logger.warn(
        {
          conditionId: params.conditionId,
          slug: params.market.slug,
          error,
        },
        "Failed to send missing-leg recovery placement decision telegram notification",
      );
    });

  const orderResult = await bot.tradingEngine.placeSingleLimitBuyAtPrice(
    imbalance.missingLegTokenId,
    finalPrice,
    cappedMissingAmount,
  );
  const orderId = bot.tradingEngine.extractOrderId(orderResult);

  return {
    status: "placed",
    finalSummary: latestSummary,
    iterations,
    lastPlacedPrice: finalPrice,
    missingLegTokenId: imbalance.missingLegTokenId,
    placedSize: cappedMissingAmount,
    orderId,
    reason:
      cappedMissingAmount < Number(effectiveMissingAmount.toFixed(6))
        ? `Placed conservative missing-leg recovery order for this cycle (${cappedMissingAmount}/${Number(effectiveMissingAmount.toFixed(6))})`
        : "Placed one missing-leg recovery order for this cycle",
  };
};

export const handleForceWindowImbalance = async (
  bot: BotDomainContext,
  params: {
    market: MarketRecord;
    conditionId: string;
    positionsAddress: string;
    tokenIds: TokenIds;
    summary: PositionSummary;
    secondsToClose: number | null;
    entryPrice: number;
  },
): Promise<{ status: "balanced" | "imbalanced" | "failed" }> => {
  const { market, conditionId, positionsAddress, tokenIds, summary, secondsToClose, entryPrice } =
    params;
  const buyCapacity = getConditionBuyCapacity(bot.config, summary);
  const missingLegTokenId =
    summary.upSize > summary.downSize ? tokenIds.downTokenId : tokenIds.upTokenId;
  const remainingForMissingLeg = getRemainingAllowanceForTokenId(
    missingLegTokenId,
    tokenIds,
    buyCapacity,
  );

  if (remainingForMissingLeg <= bot.config.positionEqualityTolerance) {
    const cancelledOpenOrders = await bot.tradingEngine.cancelEntryOpenOrders(tokenIds);
    bot.logger.warn(
      {
        conditionId,
        cancelledOpenOrders,
        summary,
        orderSizeCap: bot.config.orderSize,
        missingLegTokenId,
        secondsToClose,
      },
      "Inside force-sell window: missing leg reached strict cap, cancelled open orders and left residual imbalance",
    );
    await bot.notify({
      title: "Force-window hedge skipped (strict cap reached)",
      severity: "warn",
      dedupeKey: `force-window-cap-reached:${conditionId}`,
      slug: market.slug,
      conditionId,
      upTokenId: tokenIds.upTokenId,
      downTokenId: tokenIds.downTokenId,
      details: [
        { key: "orderSizeCap", value: bot.config.orderSize },
        { key: "up", value: summary.upSize },
        { key: "down", value: summary.downSize },
        { key: "diff", value: summary.differenceAbs },
        { key: "secondsToClose", value: secondsToClose },
      ],
    });
    return { status: "imbalanced" };
  }
  let bestMissingAsk = Number.POSITIVE_INFINITY;
  try {
    bestMissingAsk = await bot.tradingEngine.getBestAskPriceForCondition({
      conditionId,
      tokenIds,
      tokenId: missingLegTokenId,
    });
  } catch (error) {
    if (error instanceof MarketTokenMismatchError) {
      bot.logger.warn(
        {
          conditionId,
          slug: market.slug,
          tokenId: missingLegTokenId,
        },
        "Skipped force-window hedge: missing-leg token is outside current market context",
      );
      await bot.notifyOperationalIssue({
        title: "Skipped force-window hedge (market mismatch)",
        severity: "warn",
        dedupeKey: `market-token-mismatch:force-window:${conditionId}:${missingLegTokenId}`,
        slug: market.slug,
        conditionId,
        upTokenId: tokenIds.upTokenId,
        downTokenId: tokenIds.downTokenId,
        details: [{ key: "tokenId", value: missingLegTokenId }],
      });
      return { status: "imbalanced" };
    }
    throw error;
  }

  if (Number.isFinite(bestMissingAsk) && bestMissingAsk > 0) {
    const hedgeCheck = evaluateForceWindowHedge(bot.config, entryPrice, bestMissingAsk);

    if (hedgeCheck.isProfitable) {
      const cancelledOpenOrders = await bot.tradingEngine.cancelEntryOpenOrders(tokenIds);
      const hedgeBuy = await bot.tradingEngine.completeMissingLegForHedge(
        summary,
        tokenIds,
        hedgeCheck.maxHedgePrice,
      );
      const postHedgeReconcile = await bot.tradingEngine.reconcilePairedEntry({
        positionsAddress,
        conditionId,
        tokenIds,
        cancelOpenOrders: true,
      });

      if (postHedgeReconcile.status === "balanced") {
        bot.logger.info(
          {
            conditionId,
            bestMissingAsk,
            maxHedgePrice: hedgeCheck.maxHedgePrice,
            expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
            cancelledOpenOrders,
            hedgeBuy,
            summary: postHedgeReconcile.finalSummary,
            secondsToClose,
          },
          "Inside force-sell window: completed missing leg and restored balance",
        );
        return { status: "balanced" };
      }

      if (postHedgeReconcile.status === "imbalanced") {
        bot.logger.warn(
          {
            conditionId,
            bestMissingAsk,
            maxHedgePrice: hedgeCheck.maxHedgePrice,
            expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
            cancelledOpenOrders,
            hedgeBuy,
            summary: postHedgeReconcile.finalSummary,
            secondsToClose,
          },
          "Inside force-sell window: late hedge remained imbalanced",
        );
        await bot.notify({
          title: "Force-window hedge incomplete (residual imbalance)",
          severity: "warn",
          dedupeKey: `post-hedge-residual:${conditionId}`,
          slug: market.slug,
          conditionId,
          upTokenId: tokenIds.upTokenId,
          downTokenId: tokenIds.downTokenId,
          details: [
            { key: "bestMissingAsk", value: bestMissingAsk },
            { key: "maxHedgePrice", value: hedgeCheck.maxHedgePrice },
            { key: "expectedLockPnlPerShare", value: hedgeCheck.expectedLockPnlPerShare },
            { key: "up", value: postHedgeReconcile.finalSummary.upSize },
            { key: "down", value: postHedgeReconcile.finalSummary.downSize },
            { key: "diff", value: postHedgeReconcile.finalSummary.differenceAbs },
            { key: "secondsToClose", value: secondsToClose },
          ],
        });
        return { status: "imbalanced" };
      }

      bot.logger.error(
        {
          conditionId,
          bestMissingAsk,
          maxHedgePrice: hedgeCheck.maxHedgePrice,
          expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
          cancelledOpenOrders,
          hedgeBuy,
          reason: postHedgeReconcile.reason,
          summary: postHedgeReconcile.finalSummary,
          secondsToClose,
        },
        "Inside force-sell window: late hedge recovery failed",
      );
      await bot.notify({
        title: "Force-window hedge recovery failed",
        severity: "error",
        dedupeKey: `force-window-hedge-failed:${conditionId}`,
        slug: market.slug,
        conditionId,
        upTokenId: tokenIds.upTokenId,
        downTokenId: tokenIds.downTokenId,
        details: [
          { key: "bestMissingAsk", value: bestMissingAsk },
          { key: "maxHedgePrice", value: hedgeCheck.maxHedgePrice },
          { key: "expectedLockPnlPerShare", value: hedgeCheck.expectedLockPnlPerShare },
          { key: "reason", value: postHedgeReconcile.reason },
          { key: "up", value: postHedgeReconcile.finalSummary.upSize },
          { key: "down", value: postHedgeReconcile.finalSummary.downSize },
          { key: "diff", value: postHedgeReconcile.finalSummary.differenceAbs },
          { key: "secondsToClose", value: secondsToClose },
        ],
      });
      return { status: "failed" };
    }

    const cancelledOpenOrders = await bot.tradingEngine.cancelEntryOpenOrders(tokenIds);
    bot.logger.warn(
      {
        conditionId,
        bestMissingAsk,
        maxHedgePrice: hedgeCheck.maxHedgePrice,
        expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
        cancelledOpenOrders,
        summary,
        secondsToClose,
      },
      "Inside force-sell window: hedge not profitable, cancelled open orders and left residual imbalance",
    );
    await bot.notify({
      title: "Force-window hedge skipped (not profitable)",
      severity: "warn",
      dedupeKey: `force-window-skip:${conditionId}`,
      slug: market.slug,
      conditionId,
      upTokenId: tokenIds.upTokenId,
      downTokenId: tokenIds.downTokenId,
      details: [
        { key: "bestMissingAsk", value: bestMissingAsk },
        { key: "maxHedgePrice", value: hedgeCheck.maxHedgePrice },
        { key: "expectedLockPnlPerShare", value: hedgeCheck.expectedLockPnlPerShare },
        { key: "up", value: summary.upSize },
        { key: "down", value: summary.downSize },
        { key: "diff", value: summary.differenceAbs },
        { key: "secondsToClose", value: secondsToClose },
      ],
    });
    return { status: "imbalanced" };
  }

  const cancelledOpenOrders = await bot.tradingEngine.cancelEntryOpenOrders(tokenIds);
  bot.logger.warn(
    {
      conditionId,
      bestMissingAsk,
      cancelledOpenOrders,
      summary,
      secondsToClose,
    },
    "Inside force-sell window: missing-leg price unavailable, cancelled open orders and left residual imbalance",
  );
  await bot.notify({
    title: "Force-window hedge skipped (missing-leg price unavailable)",
    severity: "warn",
    dedupeKey: `force-window-missing-price:${conditionId}`,
    slug: market.slug,
    conditionId,
    upTokenId: tokenIds.upTokenId,
    downTokenId: tokenIds.downTokenId,
    details: [
      { key: "up", value: summary.upSize },
      { key: "down", value: summary.downSize },
      { key: "diff", value: summary.differenceAbs },
      { key: "secondsToClose", value: secondsToClose },
    ],
  });
  return { status: "imbalanced" };
};

export const processTrackedCurrentMarket = async (
  bot: BotDomainContext,
  params: {
    currentMarket: MarketRecord;
    currentConditionId: string;
    positionsAddress: string;
  },
): Promise<CurrentMarketResult> => {
  const { currentMarket, currentConditionId, positionsAddress } = params;

  const currentTokenIds = bot.marketDiscovery.getTokenIds(currentMarket);
  if (!currentTokenIds) {
    bot.logger.warn(
      { slug: currentMarket.slug, conditionId: currentConditionId },
      "Tracked current market missing token IDs",
    );
    await bot.notifyOperationalIssue({
      title: "Tracked current market missing token IDs",
      severity: "warn",
      dedupeKey: `tracked-market-missing-token-ids:${currentConditionId}`,
      slug: currentMarket.slug,
      conditionId: currentConditionId,
    });
    return { outcome: "failed", hasTrackedExposure: false, secondsToClose: null };
  }

  noteCurrentMarketContext(bot, currentConditionId, currentTokenIds);

  const currentPositions = await bot.dataClient.getPositions(positionsAddress, currentConditionId);
  const currentSummary = summarizePositions(currentPositions, currentTokenIds);
  const positionsEqual = arePositionsEqual(currentSummary, bot.config.positionEqualityTolerance);
  const secondsToClose = bot.marketDiscovery.getSecondsToMarketClose(currentMarket);
  const nowMs = Date.now();

  const recentPlacement = bot.recentRecoveryPlacements.get(currentConditionId);
  if (recentPlacement) {
    const changedSinceLastPlacement = didSummaryChange(recentPlacement.summary, currentSummary);
    if (positionsEqual) {
      bot.recentRecoveryPlacements.delete(currentConditionId);
    } else if (changedSinceLastPlacement) {
      bot.recentRecoveryPlacements.set(currentConditionId, {
        ...recentPlacement,
        summary: currentSummary,
      });
    }
  }

  const currentState = bot.getConditionState(currentConditionId);
  if (!positionsEqual) {
    bot.patchConditionState(currentConditionId, {
      balancedCleanupDone: false,
      balancedChecks: 0,
    });
  } else if (hasAnyFill(currentSummary)) {
    bot.patchConditionState(currentConditionId, {
      balancedChecks: currentState.balancedChecks + 1,
    });
  }

  bot.logger.debug(
    {
      conditionId: currentConditionId,
      slug: currentMarket.slug,
      up: currentSummary.upSize,
      down: currentSummary.downSize,
      diff: currentSummary.differenceAbs,
      equal: positionsEqual,
      secondsToClose,
    },
    "Position check",
  );

  const hasTrackedExposure = hasAnyFill(currentSummary);

  if (
    positionsEqual &&
    currentSummary.upSize > 0 &&
    !bot.getConditionState(currentConditionId).balancedCleanupDone
  ) {
    const cleanupOk = await bot.cancelEntryOrdersAfterBalance(currentTokenIds, {
      conditionId: currentConditionId,
      path: "tracked-market:balanced-cleanup",
    });
    if (cleanupOk) {
      bot.patchConditionState(currentConditionId, { balancedCleanupDone: true });
    }
  }

  if (
    positionsEqual &&
    currentSummary.upSize > 0 &&
    bot.relayerClient.isAvailable() &&
    !bot.getConditionState(currentConditionId).mergeAttempted
  ) {
    const balancedChecks = bot.getConditionState(currentConditionId).balancedChecks;
    if (balancedChecks < MERGE_BALANCE_CONFIRMATION_CHECKS) {
      bot.logger.info(
        {
          conditionId: currentConditionId,
          slug: currentMarket.slug,
          balancedChecks,
          requiredChecks: MERGE_BALANCE_CONFIRMATION_CHECKS,
          secondsToClose,
        },
        "Delaying merge until balance is stable across consecutive checks",
      );
      return { outcome: "balanced", hasTrackedExposure, secondsToClose };
    }

    const amount = Math.min(currentSummary.upSize, currentSummary.downSize);
    const merge = await bot.settlementService.mergeEqualPositions(currentConditionId, amount);
    const mergeObj =
      merge && typeof merge === "object" ? (merge as unknown as Record<string, unknown>) : null;
    const isRateLimitedSkip =
      mergeObj?.skipped === true && mergeObj?.reason === "relayer_rate_limited";

    if (isRateLimitedSkip) {
      bot.logger.warn(
        {
          conditionId: currentConditionId,
          retryAt: mergeObj?.retryAt,
        },
        "Merge skipped: relayer is rate limited",
      );
      await bot.notify({
        title: "Merge skipped (relayer rate limited)",
        severity: "warn",
        dedupeKey: `merge-rate-limit:${currentConditionId}`,
        slug: currentMarket.slug,
        conditionId: currentConditionId,
        upTokenId: currentTokenIds.upTokenId,
        downTokenId: currentTokenIds.downTokenId,
        details: [
          { key: "retryAt", value: mergeObj?.retryAt as string | number | undefined },
          { key: "secondsToClose", value: secondsToClose },
        ],
      });
      return { outcome: "balanced", hasTrackedExposure, secondsToClose };
    }

    const relayerMeta = bot.getRelayerMeta(merge);
    await bot.maybeNotifyRelayerFailover({
      action: merge,
      slug: currentMarket.slug,
      conditionId: currentConditionId,
      upTokenId: currentTokenIds.upTokenId,
      downTokenId: currentTokenIds.downTokenId,
    });

    bot.patchConditionState(currentConditionId, { mergeAttempted: true });
    bot.logger.info(
      {
        merge,
        conditionId: currentConditionId,
        relayerBuilder: relayerMeta?.builderLabel,
        relayerFailoverFrom: relayerMeta?.failoverFrom,
      },
      "Merge flow executed",
    );
    await bot.notify({
      title: "mergeEqualPositions executed",
      severity: "info",
      dedupeKey: `merge-success:${currentConditionId}`,
      slug: currentMarket.slug,
      conditionId: currentConditionId,
      upTokenId: currentTokenIds.upTokenId,
      downTokenId: currentTokenIds.downTokenId,
      details: [
        { key: "amount", value: amount },
        { key: "secondsToClose", value: secondsToClose },
        { key: "builder", value: relayerMeta?.builderLabel },
      ],
    });
    return { outcome: "balanced", hasTrackedExposure, secondsToClose };
  }

  if (
    !positionsEqual &&
    secondsToClose !== null &&
    secondsToClose > bot.config.forceSellThresholdSeconds
  ) {
    bot.transitionConditionLifecycle(currentConditionId, "recovery-pending");
    const placementLock = bot.recentRecoveryPlacements.get(currentConditionId);

    const recovery = await runContinuousMissingLegRecovery(bot, {
      market: currentMarket,
      conditionId: currentConditionId,
      positionsAddress,
      tokenIds: currentTokenIds,
      currentSummary,
      filledLegAvgPrice: bot.config.orderPrice,
      previousPlacement: placementLock
        ? {
            placedAtMs: placementLock.placedAtMs,
            price: placementLock.price,
            missingLegTokenId: placementLock.missingLegTokenId,
            summary: placementLock.summary,
            placedSize: placementLock.placedSize,
            orderId: placementLock.orderId,
          }
        : undefined,
    });

    if (recovery.status === "balanced") {
      bot.recentRecoveryPlacements.delete(currentConditionId);
      await bot.cancelEntryOrdersAfterBalance(currentTokenIds, {
        conditionId: currentConditionId,
        path: "tracked-market:continuous-recovery",
      });
      await bot.notifyEntryFilledOnce({
        conditionId: currentConditionId,
        slug: currentMarket.slug,
        upTokenId: currentTokenIds.upTokenId,
        downTokenId: currentTokenIds.downTokenId,
        upSize: recovery.finalSummary.upSize,
        downSize: recovery.finalSummary.downSize,
        entryPrice: bot.config.orderPrice,
        filledLegAvgPrice: bot.config.orderPrice,
        mode: "continuous-recovery",
      });
      bot.logger.info(
        {
          conditionId: currentConditionId,
          slug: currentMarket.slug,
          summary: recovery.finalSummary,
          iterations: recovery.iterations,
          lastPlacedPrice: recovery.lastPlacedPrice,
          secondsToClose,
        },
        "Recovered imbalanced current market outside force-sell window",
      );
      return { outcome: "balanced", hasTrackedExposure: true, secondsToClose };
    }

    if (recovery.status === "force-window") {
      bot.transitionConditionLifecycle(currentConditionId, "force-window");
      bot.recentRecoveryPlacements.delete(currentConditionId);
      const forceRecovery = await handleForceWindowImbalance(bot, {
        market: currentMarket,
        conditionId: currentConditionId,
        positionsAddress,
        tokenIds: currentTokenIds,
        summary: recovery.finalSummary,
        secondsToClose,
        entryPrice: bot.config.orderPrice,
      });

      if (forceRecovery.status === "balanced") {
        bot.transitionConditionLifecycle(currentConditionId, "balanced");
        await bot.cancelEntryOrdersAfterBalance(currentTokenIds, {
          conditionId: currentConditionId,
          path: "tracked-market:force-window",
        });
        await bot.notifyEntryFilledOnce({
          conditionId: currentConditionId,
          slug: currentMarket.slug,
          upTokenId: currentTokenIds.upTokenId,
          downTokenId: currentTokenIds.downTokenId,
          upSize: recovery.finalSummary.upSize,
          downSize: recovery.finalSummary.downSize,
          entryPrice: bot.config.orderPrice,
          filledLegAvgPrice: bot.config.orderPrice,
          mode: "force-window",
        });
        return { outcome: "balanced", hasTrackedExposure: true, secondsToClose };
      }
      return { outcome: "force-window", hasTrackedExposure: true, secondsToClose };
    }

    if (recovery.status === "placed") {
      bot.transitionConditionLifecycle(currentConditionId, "recovery-pending");
      if (recovery.lastPlacedPrice !== undefined && recovery.missingLegTokenId) {
        bot.recentRecoveryPlacements.set(currentConditionId, {
          placedAtMs: nowMs,
          summary: recovery.finalSummary,
          missingLegTokenId: recovery.missingLegTokenId,
          price: recovery.lastPlacedPrice,
          placedSize: recovery.placedSize ?? 0,
          orderId: recovery.orderId ?? null,
        });
      }
      bot.logger.info(
        {
          conditionId: currentConditionId,
          slug: currentMarket.slug,
          summary: recovery.finalSummary,
          iterations: recovery.iterations,
          lastPlacedPrice: recovery.lastPlacedPrice,
          reason: recovery.reason,
          secondsToClose,
        },
        "Placed one missing-leg recovery order for tracked current market",
      );
      return { outcome: "recovery-placed", hasTrackedExposure: true, secondsToClose };
    }

    if (recovery.status === "unchanged-price") {
      return { outcome: "recovery-needed", hasTrackedExposure: true, secondsToClose };
    }

    bot.logger.warn(
      {
        conditionId: currentConditionId,
        slug: currentMarket.slug,
        summary: recovery.finalSummary,
        status: recovery.status,
        reason: recovery.reason,
        iterations: recovery.iterations,
        secondsToClose,
      },
      "Continuous recovery could not rebalance current market outside force-sell window",
    );
    return { outcome: "recovery-needed", hasTrackedExposure: true, secondsToClose };
  }

  if (
    !positionsEqual &&
    secondsToClose !== null &&
    secondsToClose <= bot.config.forceSellThresholdSeconds
  ) {
    bot.transitionConditionLifecycle(currentConditionId, "force-window");
    const recovery = await handleForceWindowImbalance(bot, {
      market: currentMarket,
      conditionId: currentConditionId,
      positionsAddress,
      tokenIds: currentTokenIds,
      summary: currentSummary,
      secondsToClose,
      entryPrice: bot.config.orderPrice,
    });

    if (recovery.status !== "balanced") {
      return { outcome: "force-window", hasTrackedExposure: true, secondsToClose };
    }

    await bot.cancelEntryOrdersAfterBalance(currentTokenIds, {
      conditionId: currentConditionId,
      path: "tracked-market:force-window-existing",
    });

    bot.transitionConditionLifecycle(currentConditionId, "balanced");

    bot.logger.info(
      { conditionId: currentConditionId, secondsToClose, summary: currentSummary },
      "Recovered imbalanced current market inside force-sell window",
    );
    return { outcome: "balanced", hasTrackedExposure: true, secondsToClose };
  }

  return { outcome: positionsEqual ? "balanced" : "idle", hasTrackedExposure, secondsToClose };
};
