import type { BotConfig, EvEvaluation } from "../types/domain.js";

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export class EvGuard {
  constructor(private readonly config: BotConfig) {}

  evaluatePairedBuy(
    priceUp: number,
    priceDown: number,
    size: number,
    priceSource: "live" | "config_fallback"
  ): EvEvaluation {
    const up = clamp01(priceUp);
    const down = clamp01(priceDown);

    const grossEdgePerShare = 1 - (up + down);
    const midpointPrice = (up + down) / 2;
    const feePerShare = midpointPrice * (this.config.evEstimatedFeeBps / 10_000);
    const totalCostsPerShare =
      feePerShare +
      this.config.evEstimatedSlippagePerShare +
      this.config.evEstimatedForceSellPenaltyPerShare +
      this.config.evEstimatedPartialFillPenaltyPerShare;

    const netPerShare = grossEdgePerShare - totalCostsPerShare;
    const netTotal = netPerShare * size;
    const allowed = !this.config.evGuardEnabled || netPerShare >= this.config.evMinNetPerShare;

    return {
      allowed,
      priceUp: up,
      priceDown: down,
      priceSource,
      netPerShare,
      netTotal,
      grossEdgePerShare,
      totalCostsPerShare,
      minRequiredPerShare: this.config.evMinNetPerShare
    };
  }
}
