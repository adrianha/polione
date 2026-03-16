import type { BotConfig, PositionSummary, TokenIds } from "../types/domain.js";

export const MERGE_BALANCE_CONFIRMATION_CHECKS = 2;
export const MIN_MARKET_MAKER_ORDER_SIZE = 5;

export type BuyCapacity = {
  hasAnyExposure: boolean;
  reachedCap: boolean;
  remainingUp: number;
  remainingDown: number;
};

export const evaluateForceWindowHedge = (
  config: BotConfig,
  entryPrice: number,
  bestMissingAsk: number,
): {
  isProfitable: boolean;
  maxHedgePrice: number;
  expectedLockPnlPerShare: number;
} => {
  const maxHedgePrice =
    1 - entryPrice - config.forceWindowFeeBuffer - config.forceWindowMinProfitPerShare;

  const expectedLockPnlPerShare = 1 - entryPrice - bestMissingAsk - config.forceWindowFeeBuffer;

  return {
    isProfitable: expectedLockPnlPerShare >= config.forceWindowMinProfitPerShare,
    maxHedgePrice,
    expectedLockPnlPerShare,
  };
};

export const roundPrice = (price: number): number => Number(price.toFixed(4));

export const getImbalancePlan = (
  summary: PositionSummary,
  tokenIds: TokenIds,
): {
  filledLegTokenId: string;
  missingLegTokenId: string;
  missingAmount: number;
} | null => {
  if (summary.upSize > summary.downSize) {
    const missingAmount = Number((summary.upSize - summary.downSize).toFixed(6));
    if (missingAmount <= 0) {
      return null;
    }
    return {
      filledLegTokenId: tokenIds.upTokenId,
      missingLegTokenId: tokenIds.downTokenId,
      missingAmount,
    };
  }

  if (summary.downSize > summary.upSize) {
    const missingAmount = Number((summary.downSize - summary.upSize).toFixed(6));
    if (missingAmount <= 0) {
      return null;
    }
    return {
      filledLegTokenId: tokenIds.downTokenId,
      missingLegTokenId: tokenIds.upTokenId,
      missingAmount,
    };
  }

  return null;
};

export const getConditionBuyCapacity = (config: BotConfig, summary: PositionSummary): BuyCapacity => {
  const cap = Math.max(0, config.orderSize);
  const upSize = Math.max(0, summary.upSize);
  const downSize = Math.max(0, summary.downSize);
  const reachedCap =
    cap - upSize <= config.positionEqualityTolerance &&
    cap - downSize <= config.positionEqualityTolerance;

  return {
    hasAnyExposure: upSize > 0 || downSize > 0,
    reachedCap,
    remainingUp: Number(Math.max(0, cap - upSize).toFixed(6)),
    remainingDown: Number(Math.max(0, cap - downSize).toFixed(6)),
  };
};

export const hasAnyFill = (summary: PositionSummary): boolean => {
  return summary.upSize > 0 || summary.downSize > 0;
};

export const getRemainingAllowanceForTokenId = (
  tokenId: string,
  tokenIds: TokenIds,
  buyCapacity: BuyCapacity,
): number => {
  if (tokenId === tokenIds.upTokenId) {
    return buyCapacity.remainingUp;
  }
  if (tokenId === tokenIds.downTokenId) {
    return buyCapacity.remainingDown;
  }
  return 0;
};

export const computeMakerMissingLegPrice = (params: {
  config: BotConfig;
  bestBid: number;
  bestAsk: number;
  maxMissingPrice: number;
  makerOffset?: number;
}): number => {
  const bestBid = Math.max(0, params.bestBid);
  const bestAsk = Math.max(0, params.bestAsk);
  const maxMissingPrice = Math.max(0, params.maxMissingPrice);
  const makerOffset = Math.max(0, params.makerOffset ?? params.config.entryContinuousMakerOffset);
  if (maxMissingPrice <= 0 || bestBid <= 0 || bestAsk <= 0) {
    return 0;
  }

  const makerCandidate = bestBid + makerOffset;
  const nonCrossingCap = Math.max(0, bestAsk - makerOffset);
  const bounded = Math.min(maxMissingPrice, makerCandidate, nonCrossingCap);
  return roundPrice(bounded);
};

export const getTimeAwareRecoveryPolicy = (
  config: BotConfig,
  secondsToClose: number | null,
): {
  progress: number;
  extraProfitBuffer: number;
  makerOffset: number;
  sizeFraction: number;
} => {
  if (secondsToClose === null) {
    return {
      progress: 0,
      extraProfitBuffer: 0,
      makerOffset: config.entryContinuousMakerOffset,
      sizeFraction: 1,
    };
  }

  const forceThreshold = config.forceSellThresholdSeconds;
  const horizon = Math.max(forceThreshold + 1, config.entryRecoveryHorizonSeconds);
  const rawProgress = (secondsToClose - forceThreshold) / (horizon - forceThreshold);
  const progress = Math.min(1, Math.max(0, rawProgress));

  const minSizeFraction = Math.min(1, Math.max(0, config.entryRecoveryMinSizeFraction));

  return {
    progress,
    extraProfitBuffer: config.entryRecoveryExtraProfitMax * progress,
    makerOffset:
      config.entryContinuousMakerOffset + config.entryRecoveryPassiveOffsetMax * progress,
    sizeFraction: 1 - progress * (1 - minSizeFraction),
  };
};

export const didSummaryChange = (previous: PositionSummary, current: PositionSummary): boolean => {
  const epsilon = 1e-6;
  return (
    Math.abs(previous.upSize - current.upSize) > epsilon ||
    Math.abs(previous.downSize - current.downSize) > epsilon
  );
};
