import { summarizePositions } from "../services/positionManager.js";
import type { MarketRecord } from "../types/domain.js";
import type { EntryOpportunityResult, MarketContext } from "./marketFlowTypes.js";

type BotLike = any;

export const selectEntryMarket = (bot: BotLike, params: MarketContext): MarketRecord | null => {
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
  bot: BotLike,
  params: {
    entryMarket: MarketRecord;
    currentConditionId: string | null;
    positionsAddress: string;
  },
): Promise<EntryOpportunityResult> => {
  return bot.processEntryMarketCore(params);
};
