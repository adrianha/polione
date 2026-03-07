import type { BotConfig, TokenIds } from "../types/domain.js";
import type { PolyClobClient } from "../clients/clobClient.js";

export class TradingEngine {
  constructor(
    private readonly config: BotConfig,
    private readonly clobClient: PolyClobClient
  ) {}

  async placePairedLimitBuys(tokenIds: TokenIds): Promise<{ up: unknown; down: unknown }> {
    const up = await this.clobClient.placeLimitOrder({
      tokenId: tokenIds.upTokenId,
      side: "BUY",
      price: this.config.orderPrice,
      size: this.config.orderSize
    });

    const down = await this.clobClient.placeLimitOrder({
      tokenId: tokenIds.downTokenId,
      side: "BUY",
      price: this.config.orderPrice,
      size: this.config.orderSize
    });

    return { up, down };
  }

  async forceSellAll(summary: { upSize: number; downSize: number }, tokenIds: TokenIds): Promise<{ up?: unknown; down?: unknown }> {
    const results: { up?: unknown; down?: unknown } = {};

    if (summary.upSize > 0) {
      results.up = await this.clobClient.placeMarketOrder({
        tokenId: tokenIds.upTokenId,
        side: "SELL",
        amount: summary.upSize,
        price: 0.01
      });
    }

    if (summary.downSize > 0) {
      results.down = await this.clobClient.placeMarketOrder({
        tokenId: tokenIds.downTokenId,
        side: "SELL",
        amount: summary.downSize,
        price: 0.01
      });
    }

    return results;
  }
}
