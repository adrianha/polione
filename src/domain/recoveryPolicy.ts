import type { PositionSummary, TokenIds } from "../types/domain.js";

export interface ImbalancePlan {
  filledLegTokenId: string;
  missingLegTokenId: string;
  missingAmount: number;
}

export interface ForceWindowHedgeEvaluation {
  isProfitable: boolean;
  maxHedgePrice: number;
  expectedLockPnlPerShare: number;
}

export const evaluateForceWindowHedge = (params: {
  entryPrice: number;
  bestMissingAsk: number;
  forceWindowFeeBuffer: number;
  forceWindowMinProfitPerShare: number;
}): ForceWindowHedgeEvaluation => {
  const maxHedgePrice =
    1 - params.entryPrice - params.forceWindowFeeBuffer - params.forceWindowMinProfitPerShare;

  const expectedLockPnlPerShare = 1 - params.entryPrice - params.bestMissingAsk - params.forceWindowFeeBuffer;

  return {
    isProfitable: expectedLockPnlPerShare >= params.forceWindowMinProfitPerShare,
    maxHedgePrice,
    expectedLockPnlPerShare,
  };
};

export const getImbalancePlan = (summary: PositionSummary, tokenIds: TokenIds): ImbalancePlan | null => {
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

export const computeMakerMissingLegPrice = (params: {
  bestBid: number;
  bestAsk: number;
  maxMissingPrice: number;
  entryContinuousMakerOffset: number;
}): number => {
  const bestBid = Math.max(0, params.bestBid);
  const bestAsk = Math.max(0, params.bestAsk);
  const maxMissingPrice = Math.max(0, params.maxMissingPrice);
  if (maxMissingPrice <= 0 || bestBid <= 0 || bestAsk <= 0) {
    return 0;
  }

  const makerCandidate = bestBid + params.entryContinuousMakerOffset;
  const nonCrossingCap = Math.max(0, bestAsk - params.entryContinuousMakerOffset);
  const bounded = Math.min(maxMissingPrice, makerCandidate, nonCrossingCap);
  return Number(bounded.toFixed(4));
};
