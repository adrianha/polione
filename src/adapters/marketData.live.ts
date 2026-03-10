import { Effect, Layer } from "effect";
import type { BotConfig, MarketRecord, TokenIds } from "../types/domain.js";
import { getCurrentEpochTimestamp, getNextEpochTimestamp, unixNow } from "../utils/time.js";
import { adapterError } from "../app/errors.js";
import { MarketData, type MarketData as MarketDataPort } from "../ports/MarketData.js";
import { GammaClient } from "../clients/gammaClient.js";

const buildSlug = (prefix: string, epochSec: number): string => `${prefix}-${epochSec}`;

const parseMarketRecord = (value: unknown): MarketRecord => {
  if (!value || typeof value !== "object") {
    throw new Error("Gamma market payload must be an object");
  }

  const record = value as Record<string, unknown>;
  const asStringIfPresent = (field: string): string | undefined => {
    const fieldValue = record[field];
    if (fieldValue === undefined || fieldValue === null) {
      return undefined;
    }
    if (typeof fieldValue !== "string") {
      throw new Error(`Gamma market field '${field}' must be a string when present`);
    }
    return fieldValue;
  };

  const asBooleanIfPresent = (field: string): boolean | undefined => {
    const fieldValue = record[field];
    if (fieldValue === undefined || fieldValue === null) {
      return undefined;
    }
    if (typeof fieldValue !== "boolean") {
      throw new Error(`Gamma market field '${field}' must be a boolean when present`);
    }
    return fieldValue;
  };

  const maybeTokens = record.tokens;
  if (maybeTokens !== undefined && maybeTokens !== null && !Array.isArray(maybeTokens)) {
    throw new Error("Gamma market field 'tokens' must be an array when present");
  }

  return {
    ...record,
    id: asStringIfPresent("id"),
    slug: asStringIfPresent("slug"),
    question: asStringIfPresent("question"),
    conditionId: asStringIfPresent("conditionId"),
    condition_id: asStringIfPresent("condition_id"),
    endDate: asStringIfPresent("endDate"),
    end_date_iso: asStringIfPresent("end_date_iso"),
    active: asBooleanIfPresent("active"),
    closed: asBooleanIfPresent("closed"),
    archived: asBooleanIfPresent("archived"),
    clobTokenIds: record.clobTokenIds,
    tokens: maybeTokens as unknown[] | undefined,
  };
};

const parseClobTokenIds = (raw: unknown): string[] => {
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }

  if (typeof raw === "string") {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
  }

  return [];
};

const getTokenIds = (market: MarketRecord): TokenIds | null => {
  const clob = parseClobTokenIds(market.clobTokenIds);
  if (clob.length >= 2) {
    if (clob[0].length === 0 || clob[1].length === 0) {
      throw new Error("Gamma market clobTokenIds entries must be non-empty strings");
    }
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

const getConditionId = (market: MarketRecord): string | null => {
  const raw = market.conditionId ?? market.condition_id;
  if (typeof raw !== "string") {
    return null;
  }
  if (raw.length === 0) {
    throw new Error("Gamma market condition ID must not be empty");
  }
  return raw;
};

const getSecondsToMarketClose = (market: MarketRecord): number | null => {
  const endDate = typeof market.endDate === "string" ? market.endDate : market.end_date_iso;
  if (typeof endDate !== "string") {
    return null;
  }

  const unix = Math.floor(new Date(endDate).getTime() / 1000);
  if (!Number.isFinite(unix)) {
    throw new Error("Gamma market end date must be a valid ISO string");
  }

  return unix - unixNow();
};

export const makeMarketData = (params: { config: BotConfig; gammaClient: GammaClient }): MarketDataPort => ({
  findCurrentActiveMarket: Effect.tryPromise({
    try: async () => {
      const currentEpoch = getCurrentEpochTimestamp(unixNow(), params.config.marketIntervalSeconds);
      const slug = buildSlug(params.config.marketSlugPrefix, currentEpoch);
      const market = await params.gammaClient.getMarketBySlug(slug);
      return market ? parseMarketRecord(market) : null;
    },
    catch: (cause) => adapterError({ adapter: "GammaClient", operation: "findCurrentActiveMarket", cause }),
  }),
  findNextActiveMarket: Effect.tryPromise({
    try: async () => {
      const now = unixNow();
      const candidates = [
        getNextEpochTimestamp(now, params.config.marketIntervalSeconds),
        getCurrentEpochTimestamp(now, params.config.marketIntervalSeconds),
      ];

      for (const candidate of candidates) {
        const slug = buildSlug(params.config.marketSlugPrefix, candidate);
        const market = await params.gammaClient.getMarketBySlug(slug);
        if (market) {
          return parseMarketRecord(market);
        }
      }

      return null;
    },
    catch: (cause) => adapterError({ adapter: "GammaClient", operation: "findNextActiveMarket", cause }),
  }),
  getTokenIds,
  getConditionId,
  getSecondsToMarketClose,
});

export const MarketDataLive = (params: { config: BotConfig; gammaClient: GammaClient }): Layer.Layer<MarketDataPort> =>
  Layer.succeed(MarketData, makeMarketData(params));
