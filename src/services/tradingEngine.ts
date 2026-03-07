import type { BotConfig, EvEvaluation, TokenIds } from "../types/domain.js";
import type { PolyClobClient } from "../clients/clobClient.js";
import { EvGuard } from "./evGuard.js";

export class TradingEngine {
  private readonly evGuard: EvGuard;

  constructor(
    private readonly config: BotConfig,
    private readonly clobClient: PolyClobClient
  ) {
    this.evGuard = new EvGuard(config);
  }

  private sanitizePrice(value: number): number {
    if (!Number.isFinite(value)) {
      return this.config.orderPrice;
    }
    return Math.min(1, Math.max(0, value));
  }

  async evaluateEntry(tokenIds: TokenIds): Promise<EvEvaluation> {
    const midpointUp = await this.clobClient.getMidpointPrice(tokenIds.upTokenId);
    const midpointDown = await this.clobClient.getMidpointPrice(tokenIds.downTokenId);

    const usingLive = midpointUp !== null && midpointDown !== null;
    const priceUp = this.sanitizePrice(usingLive ? midpointUp : this.config.orderPrice);
    const priceDown = this.sanitizePrice(usingLive ? midpointDown : this.config.orderPrice);

    return this.evGuard.evaluatePairedBuy(
      priceUp,
      priceDown,
      this.config.orderSize,
      usingLive ? "live" : "config_fallback"
    );
  }

  async placePairedLimitBuys(tokenIds: TokenIds): Promise<{ up: unknown; down: unknown }> {
    const batchResult = await this.clobClient.placeLimitOrdersBatch([
      {
        tokenId: tokenIds.upTokenId,
        side: "BUY",
        price: this.config.orderPrice,
        size: this.config.orderSize
      },
      {
        tokenId: tokenIds.downTokenId,
        side: "BUY",
        price: this.config.orderPrice,
        size: this.config.orderSize
      }
    ]);

    if (batchResult && typeof batchResult === "object" && "dryRun" in batchResult) {
      const dryRunPayload = batchResult as {
        dryRun: boolean;
        intents?: unknown[];
      };
      return {
        up: dryRunPayload.intents?.[0],
        down: dryRunPayload.intents?.[1]
      };
    }

    const posted = Array.isArray(batchResult) ? batchResult : [];

    return {
      up: posted[0] ?? batchResult,
      down: posted[1] ?? batchResult
    };
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
