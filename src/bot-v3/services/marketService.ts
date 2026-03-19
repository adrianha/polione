import type { Logger } from "pino";
import type { MarketRecord } from "../../types/domain.js";
import { GammaClient } from "../../clients/gammaClient.js";
import { PolyClobClient } from "../../clients/clobClient.js";
import { getCurrentEpochTimestamp, unixNow } from "../../utils/time.js";
import type { V3Config, V3MarketSnapshot, V3MarketTokenQuote } from "../types.js";

interface ParsedToken {
  tokenId: string;
  outcome: string;
}

const buildSlug = (prefix: string, epochSec: number): string => `${prefix}-${epochSec}`;

const parseClobTokenIds = (raw: unknown): string[] => {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value));
  }
  if (typeof raw !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
};

const parseConditionId = (market: MarketRecord): string | null => {
  const raw = market.conditionId ?? market.condition_id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
};

const parseEndDate = (market: MarketRecord): string | null => {
  const raw = market.endDate ?? market.end_date_iso;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
};

const parseTokens = (market: MarketRecord): [ParsedToken, ParsedToken] | null => {
  if (Array.isArray(market.tokens) && market.tokens.length >= 2) {
    const parsed = market.tokens
      .slice(0, 2)
      .map((value, index) => {
        if (!value || typeof value !== "object") {
          return null;
        }
        const record = value as Record<string, unknown>;
        const tokenId = record.token_id;
        if (typeof tokenId !== "string" || tokenId.length === 0) {
          return null;
        }
        const outcomeRaw = record.outcome;
        const outcome = typeof outcomeRaw === "string" && outcomeRaw.length > 0 ? outcomeRaw : `Outcome ${index + 1}`;
        return { tokenId, outcome };
      })
      .filter((value): value is ParsedToken => value !== null);

    if (parsed.length >= 2) {
      return [parsed[0], parsed[1]];
    }
  }

  const tokenIds = parseClobTokenIds(market.clobTokenIds);
  if (tokenIds.length >= 2) {
    return [
      { tokenId: tokenIds[0], outcome: "Outcome 1" },
      { tokenId: tokenIds[1], outcome: "Outcome 2" },
    ];
  }

  return null;
};

export class V3MarketService {
  constructor(
    private readonly config: V3Config,
    private readonly gammaClient: GammaClient,
    private readonly clobClient: PolyClobClient,
    private readonly logger: Logger,
  ) {}

  generateCurrentSlug(): string {
    const currentEpoch = getCurrentEpochTimestamp(unixNow(), this.config.marketIntervalSeconds);
    return buildSlug(this.config.marketSlugPrefix, currentEpoch);
  }

  async getCurrentMarketSnapshot(): Promise<V3MarketSnapshot | null> {
    return this.getMarketSnapshotBySlug(this.generateCurrentSlug());
  }

  async getMarketSnapshotBySlug(slug: string): Promise<V3MarketSnapshot | null> {
    const market = await this.gammaClient.getMarketBySlug(slug);
    if (!market) {
      return null;
    }

    const conditionId = parseConditionId(market);
    const tokens = parseTokens(market);
    if (!conditionId || !tokens) {
      this.logger.debug({ slug }, "Skipped V3 market snapshot: missing condition or tokens");
      return null;
    }

    const quotes = await Promise.all(tokens.map((token) => this.getTokenQuote(token.tokenId, token.outcome)));
    const secondsToClose = this.getSecondsToClose(market);

    return {
      market,
      slug,
      conditionId,
      secondsToClose,
      tokens: [quotes[0], quotes[1]],
      fetchedAtMs: Date.now(),
    };
  }

  getSecondsToClose(market: MarketRecord): number | null {
    const endDate = parseEndDate(market);
    if (!endDate) {
      return null;
    }
    const closeUnix = Math.floor(new Date(endDate).getTime() / 1000);
    if (!Number.isFinite(closeUnix)) {
      return null;
    }
    return closeUnix - unixNow();
  }

  isClosed(market: MarketRecord): boolean {
    return market.closed === true || market.active === false || market.archived === true;
  }

  private async getTokenQuote(tokenId: string, outcome: string): Promise<V3MarketTokenQuote> {
    const [bestBidRaw, bestAskRaw] = await Promise.all([
      this.clobClient.getPrice(tokenId, "BUY").catch(() => 0),
      this.clobClient.getPrice(tokenId, "SELL").catch(() => 0),
    ]);

    const bestBid = this.parsePrice(bestBidRaw);
    const bestAsk = this.parsePrice(bestAskRaw);

    return {
      tokenId,
      outcome,
      bestBid,
      bestAsk,
    };
  }

  private parsePrice(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return Number(parsed.toFixed(4));
  }
}
