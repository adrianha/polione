import type { BotConfig, MarketRecord, TokenIds } from "../types/domain.js";
import { getCurrentEpochTimestamp, getNextEpochTimestamp, unixNow } from "../utils/time.js";
import { GammaClient } from "../clients/gammaClient.js";

const buildSlug = (prefix: string, epochSec: number): string => `${prefix}-${epochSec}`;

const parseClobTokenIds = (raw: unknown): string[] => {
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {
      return [];
    }
  }

  return [];
};

const parseTokens = (market: MarketRecord): TokenIds | null => {
  const clob = parseClobTokenIds(market.clobTokenIds);
  if (clob.length >= 2) {
    return { upTokenId: clob[0], downTokenId: clob[1] };
  }

  if (Array.isArray(market.tokens) && market.tokens.length >= 2) {
    const tokenA = market.tokens[0] as Record<string, unknown>;
    const tokenB = market.tokens[1] as Record<string, unknown>;
    if (typeof tokenA.token_id === "string" && typeof tokenB.token_id === "string") {
      return {
        upTokenId: tokenA.token_id,
        downTokenId: tokenB.token_id,
      };
    }
  }

  return null;
};

export class MarketDiscoveryService {
  constructor(
    private readonly config: BotConfig,
    private readonly gammaClient: GammaClient,
  ) {}

  generateSlug(timestampSec: number): string {
    return buildSlug(this.config.marketSlugPrefix, timestampSec);
  }

  async findCurrentActiveMarket(): Promise<MarketRecord | null> {
    const currentEpoch = getCurrentEpochTimestamp(unixNow(), this.config.marketIntervalSeconds);
    const slug = this.generateSlug(currentEpoch);
    return this.gammaClient.getMarketBySlug(slug);
  }

  async findNextActiveMarket(): Promise<MarketRecord | null> {
    const now = unixNow();
    const candidates = [
      getNextEpochTimestamp(now, this.config.marketIntervalSeconds),
      getCurrentEpochTimestamp(now, this.config.marketIntervalSeconds),
    ];

    for (const candidate of candidates) {
      const slug = this.generateSlug(candidate);
      const market = await this.gammaClient.getMarketBySlug(slug);
      if (market) {
        return market;
      }
    }

    return null;
  }

  getTokenIds(market: MarketRecord): TokenIds | null {
    return parseTokens(market);
  }

  getConditionId(market: MarketRecord): string | null {
    const raw = market.conditionId ?? market.condition_id;
    return typeof raw === "string" ? raw : null;
  }

  getSecondsToMarketClose(market: MarketRecord): number | null {
    const endDate = typeof market.endDate === "string" ? market.endDate : market.end_date_iso;
    if (typeof endDate !== "string") {
      return null;
    }
    const unix = Math.floor(new Date(endDate).getTime() / 1000);
    if (!Number.isFinite(unix)) {
      return null;
    }
    return unix - unixNow();
  }
}
