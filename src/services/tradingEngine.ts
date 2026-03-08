import type { BotConfig, TokenIds } from "../types/domain.js";
import type { PolyClobClient } from "../clients/clobClient.js";

export class TradingEngine {
  constructor(
    private readonly config: BotConfig,
    private readonly clobClient: PolyClobClient,
  ) {}

  async placePairedLimitBuys(tokenIds: TokenIds): Promise<{ up: unknown; down: unknown }> {
    const batchResult = await this.clobClient.placeLimitOrdersBatch([
      {
        tokenId: tokenIds.upTokenId,
        side: "BUY",
        price: this.config.orderPrice,
        size: this.config.orderSize,
      },
      {
        tokenId: tokenIds.downTokenId,
        side: "BUY",
        price: this.config.orderPrice,
        size: this.config.orderSize,
      },
    ]);

    if (batchResult && typeof batchResult === "object" && "dryRun" in batchResult) {
      const dryRunPayload = batchResult as {
        dryRun: boolean;
        intents?: unknown[];
      };
      return {
        up: dryRunPayload.intents?.[0],
        down: dryRunPayload.intents?.[1],
      };
    }

    const posted = Array.isArray(batchResult) ? batchResult : [];

    return {
      up: posted[0] ?? batchResult,
      down: posted[1] ?? batchResult,
    };
  }

  async forceSellAll(
    summary: { upSize: number; downSize: number },
    tokenIds: TokenIds,
  ): Promise<{ up?: unknown; down?: unknown }> {
    const results: { up?: unknown; down?: unknown } = {};

    if (summary.upSize > 0) {
      results.up = await this.clobClient.placeMarketOrder({
        tokenId: tokenIds.upTokenId,
        side: "SELL",
        amount: summary.upSize,
        price: 0.01,
      });
    }

    if (summary.downSize > 0) {
      results.down = await this.clobClient.placeMarketOrder({
        tokenId: tokenIds.downTokenId,
        side: "SELL",
        amount: summary.downSize,
        price: 0.01,
      });
    }

    return results;
  }
}
