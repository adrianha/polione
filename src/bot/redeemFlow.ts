type BotLike = any;

export const processRedeemablePositions = async (
  bot: BotLike,
  positionsAddress: string,
): Promise<void> => {
  await bot.processRedeemablePositionsCore(positionsAddress);
};
