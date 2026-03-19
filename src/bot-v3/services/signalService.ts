import type { V3Config, V3EntrySignal, V3MarketSnapshot } from "../types.js";

export class V3SignalService {
  constructor(private readonly config: V3Config) {}

  evaluate(snapshot: V3MarketSnapshot): V3EntrySignal | null {
    if (snapshot.secondsToClose !== null && snapshot.secondsToClose <= 0) {
      return null;
    }

    const [tokenA, tokenB] = snapshot.tokens;
    if (tokenA.bestAsk <= 0 || tokenB.bestAsk <= 0) {
      return null;
    }

    if (Math.abs(tokenA.bestAsk - tokenB.bestAsk) < 1e-6) {
      return null;
    }

    const favorite = tokenA.bestAsk > tokenB.bestAsk ? tokenA : tokenB;
    if (favorite.bestAsk < this.config.entryThreshold) {
      return null;
    }
    if (favorite.bestAsk > this.config.maxEntryAsk) {
      return null;
    }

    return {
      conditionId: snapshot.conditionId,
      slug: snapshot.slug,
      tokenId: favorite.tokenId,
      outcome: favorite.outcome,
      bestBid: favorite.bestBid,
      bestAsk: favorite.bestAsk,
      secondsToClose: snapshot.secondsToClose,
    };
  }
}
