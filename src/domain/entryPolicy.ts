import type { MarketRecord } from "../types/domain.js";

export const selectEntryMarket = (params: {
  currentMarket: MarketRecord | null;
  nextMarket: MarketRecord | null;
  currentConditionId: string | null;
  getConditionId: (market: MarketRecord) => string | null;
}): MarketRecord | null => {
  const { currentMarket, nextMarket, currentConditionId, getConditionId } = params;

  if (nextMarket) {
    const nextConditionId = getConditionId(nextMarket);
    if (!currentConditionId || nextConditionId !== currentConditionId) {
      return nextMarket;
    }
  }

  return currentMarket;
};
