import { z } from "zod";
import type { BotConfig } from "../types/domain.js";

const boolString = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ["true", "false"].includes(value), {
    message: "must be true or false",
  })
  .transform((value) => value === "true");

const schema = z.object({
  DRY_RUN: boolString.default(true),
  PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "PRIVATE_KEY must be 0x + 64 hex characters"),
  FUNDER: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  SIGNATURE_TYPE: z.coerce.number().int().min(0).max(2).default(0),
  CHAIN_ID: z.coerce
    .number()
    .int()
    .refine((v) => v === 137 || v === 80002, {
      message: "CHAIN_ID must be 137 or 80002",
    })
    .default(137),
  CLOB_API_HOST: z.string().url().default("https://clob.polymarket.com"),
  GAMMA_API_BASE_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  DATA_API_BASE_URL: z.string().url().default("https://data-api.polymarket.com"),
  POLYGON_RPC: z.string().url().optional(),
  POLYMARKET_RELAYER_URL: z.string().url().optional(),
  BUILDER_API_KEY: z.string().optional(),
  BUILDER_API_SECRET: z.string().optional(),
  BUILDER_API_PASSPHRASE: z.string().optional(),
  BUILDER_SIGNER_URL: z.string().url().optional(),
  BUILDER_SIGNER_TOKEN: z.string().optional(),
  MARKET_SLUG_PREFIX: z.string().default("btc-updown-5m"),
  MARKET_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  ORDER_PRICE: z.coerce.number().min(0).max(1).default(0.46),
  ORDER_SIZE: z.coerce.number().positive().default(5),
  POSITION_EQUALITY_TOLERANCE: z.coerce.number().positive().default(0.01),
  FORCE_SELL_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(30),
  LOOP_SLEEP_SECONDS: z.coerce.number().int().positive().default(10),
  POSITION_RECHECK_SECONDS: z.coerce.number().int().positive().default(60),
  ENTRY_RECONCILE_SECONDS: z.coerce.number().int().positive().default(15),
  ENTRY_RECONCILE_POLL_SECONDS: z.coerce.number().int().positive().default(3),
  ENTRY_CANCEL_OPEN_ORDERS: boolString.default(true),
  ENTRY_MAX_REPRICE_ATTEMPTS: z.coerce.number().int().min(0).default(2),
  ENTRY_REPRICE_STEP: z.coerce.number().positive().default(0.01),
  ENTRY_MAX_PRICE: z.coerce.number().min(0).max(1).default(0.5),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  REQUEST_RETRIES: z.coerce.number().int().min(0).default(3),
  REQUEST_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(500),
  STATE_FILE_PATH: z.string().default(".bot-state.json"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export const loadConfig = (): BotConfig => {
  const parsed = schema.parse(process.env);

  return {
    dryRun: parsed.DRY_RUN,
    privateKey: parsed.PRIVATE_KEY as `0x${string}`,
    funder: parsed.FUNDER as `0x${string}` | undefined,
    signatureType: parsed.SIGNATURE_TYPE as 0 | 1 | 2,
    chainId: parsed.CHAIN_ID as 137 | 80002,
    clobApiHost: parsed.CLOB_API_HOST,
    gammaApiBaseUrl: parsed.GAMMA_API_BASE_URL,
    dataApiBaseUrl: parsed.DATA_API_BASE_URL,
    polygonRpc: parsed.POLYGON_RPC,
    polymarketRelayerUrl: parsed.POLYMARKET_RELAYER_URL,
    builderApiKey: parsed.BUILDER_API_KEY,
    builderApiSecret: parsed.BUILDER_API_SECRET,
    builderApiPassphrase: parsed.BUILDER_API_PASSPHRASE,
    builderSignerUrl: parsed.BUILDER_SIGNER_URL,
    builderSignerToken: parsed.BUILDER_SIGNER_TOKEN,
    marketSlugPrefix: parsed.MARKET_SLUG_PREFIX,
    marketIntervalSeconds: parsed.MARKET_INTERVAL_SECONDS,
    orderPrice: parsed.ORDER_PRICE,
    orderSize: parsed.ORDER_SIZE,
    positionEqualityTolerance: parsed.POSITION_EQUALITY_TOLERANCE,
    forceSellThresholdSeconds: parsed.FORCE_SELL_THRESHOLD_SECONDS,
    loopSleepSeconds: parsed.LOOP_SLEEP_SECONDS,
    positionRecheckSeconds: parsed.POSITION_RECHECK_SECONDS,
    entryReconcileSeconds: parsed.ENTRY_RECONCILE_SECONDS,
    entryReconcilePollSeconds: parsed.ENTRY_RECONCILE_POLL_SECONDS,
    entryCancelOpenOrders: parsed.ENTRY_CANCEL_OPEN_ORDERS,
    entryMaxRepriceAttempts: parsed.ENTRY_MAX_REPRICE_ATTEMPTS,
    entryRepriceStep: parsed.ENTRY_REPRICE_STEP,
    entryMaxPrice: parsed.ENTRY_MAX_PRICE,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    requestRetries: parsed.REQUEST_RETRIES,
    requestRetryBackoffMs: parsed.REQUEST_RETRY_BACKOFF_MS,
    stateFilePath: parsed.STATE_FILE_PATH,
    logLevel: parsed.LOG_LEVEL,
  };
};
