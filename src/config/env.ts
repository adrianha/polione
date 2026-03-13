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
  CLOB_WS_URL: z.string().url().default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  ENABLE_CLOB_WS: boolString.default(true),
  WS_QUOTES_MAX_AGE_MS: z.coerce.number().int().positive().default(2000),
  WS_RECONNECT_DELAY_MS: z.coerce.number().int().positive().default(2000),
  GAMMA_API_BASE_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  DATA_API_BASE_URL: z.string().url().default("https://data-api.polymarket.com"),
  POLYGON_RPC: z.string().url().optional(),
  POLYMARKET_RELAYER_URL: z.string().url().optional(),
  BUILDER_API_KEY: z.string().optional(),
  BUILDER_API_SECRET: z.string().optional(),
  BUILDER_API_PASSPHRASE: z.string().optional(),
  BUILDER_API_KEY_2: z.string().optional(),
  BUILDER_API_SECRET_2: z.string().optional(),
  BUILDER_API_PASSPHRASE_2: z.string().optional(),
  BUILDER_SIGNER_URL: z.string().url().optional(),
  BUILDER_SIGNER_TOKEN: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  MARKET_SLUG_PREFIX: z.string().default("btc-updown-5m"),
  MARKET_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  ORDER_PRICE: z.coerce.number().min(0).max(1).default(0.46),
  ORDER_SIZE: z.coerce.number().positive().default(5),
  POSITION_EQUALITY_TOLERANCE: z.coerce.number().positive().default(0.01),
  FORCE_SELL_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(30),
  LOOP_SLEEP_SECONDS: z.coerce.number().int().positive().default(10),
  CURRENT_LOOP_SLEEP_SECONDS: z.coerce.number().int().positive().default(3),
  REDEEM_LOOP_SLEEP_SECONDS: z.coerce.number().int().positive().default(60),
  REDEEM_ENABLED: boolString.default(true),
  REDEEM_MAX_RETRIES: z.coerce.number().int().min(1).default(8),
  REDEEM_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(60000),
  REDEEM_SUCCESS_COOLDOWN_MS: z.coerce.number().int().positive().default(300000),
  REDEEM_MAX_PER_LOOP: z.coerce.number().int().positive().default(20),
  REDEEM_TERMINAL_STATE_TTL_MS: z.coerce.number().int().positive().default(604800000),
  POSITION_RECHECK_SECONDS: z.coerce.number().int().positive().default(60),
  ENTRY_RECONCILE_SECONDS: z.coerce.number().int().positive().default(15),
  ENTRY_RECONCILE_POLL_SECONDS: z.coerce.number().int().positive().default(3),
  ENTRY_CANCEL_OPEN_ORDERS: boolString.default(true),
  FORCE_WINDOW_FEE_BUFFER: z.coerce.number().min(0).default(0.01),
  FORCE_WINDOW_MIN_PROFIT_PER_SHARE: z.coerce.number().min(0).default(0.005),
  ENTRY_CONTINUOUS_REPRICE_ENABLED: boolString.default(true),
  ENTRY_CONTINUOUS_REPRICE_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  ENTRY_CONTINUOUS_MIN_PRICE_DELTA: z.coerce.number().positive().default(0.002),
  ENTRY_CONTINUOUS_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(45),
  ENTRY_CONTINUOUS_MAKER_OFFSET: z.coerce.number().min(0).default(0.001),
  ENTRY_RECOVERY_HORIZON_SECONDS: z.coerce.number().int().positive().default(120),
  ENTRY_RECOVERY_EXTRA_PROFIT_MAX: z.coerce.number().min(0).default(0.01),
  ENTRY_RECOVERY_MIN_SIZE_FRACTION: z.coerce.number().positive().max(1).default(0.35),
  ENTRY_RECOVERY_PASSIVE_OFFSET_MAX: z.coerce.number().min(0).default(0.004),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  REQUEST_RETRIES: z.coerce.number().int().min(0).default(3),
  REQUEST_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(500),
  STATE_FILE_PATH: z.string().default(".bot-state.json"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

const assertCompleteBuilderCreds = (
  label: string,
  creds: {
    key?: string;
    secret?: string;
    passphrase?: string;
  },
): void => {
  const hasAll = Boolean(creds.key) && Boolean(creds.secret) && Boolean(creds.passphrase);
  const hasAny = Boolean(creds.key) || Boolean(creds.secret) || Boolean(creds.passphrase);

  if (hasAny && !hasAll) {
    throw new Error(`Invalid ${label} configuration: key, secret, and passphrase must all be set`);
  }
};

export const loadConfig = (): BotConfig => {
  const parsed = schema.parse(process.env);

  assertCompleteBuilderCreds("primary builder credentials", {
    key: parsed.BUILDER_API_KEY,
    secret: parsed.BUILDER_API_SECRET,
    passphrase: parsed.BUILDER_API_PASSPHRASE,
  });

  assertCompleteBuilderCreds("secondary builder credentials", {
    key: parsed.BUILDER_API_KEY_2,
    secret: parsed.BUILDER_API_SECRET_2,
    passphrase: parsed.BUILDER_API_PASSPHRASE_2,
  });

  return {
    dryRun: parsed.DRY_RUN,
    privateKey: parsed.PRIVATE_KEY as `0x${string}`,
    funder: parsed.FUNDER as `0x${string}` | undefined,
    signatureType: parsed.SIGNATURE_TYPE as 0 | 1 | 2,
    chainId: parsed.CHAIN_ID as 137 | 80002,
    clobApiHost: parsed.CLOB_API_HOST,
    clobWsUrl: parsed.CLOB_WS_URL,
    enableClobWs: parsed.ENABLE_CLOB_WS,
    wsQuotesMaxAgeMs: parsed.WS_QUOTES_MAX_AGE_MS,
    wsReconnectDelayMs: parsed.WS_RECONNECT_DELAY_MS,
    gammaApiBaseUrl: parsed.GAMMA_API_BASE_URL,
    dataApiBaseUrl: parsed.DATA_API_BASE_URL,
    polygonRpc: parsed.POLYGON_RPC,
    polymarketRelayerUrl: parsed.POLYMARKET_RELAYER_URL,
    builderApiKey: parsed.BUILDER_API_KEY,
    builderApiSecret: parsed.BUILDER_API_SECRET,
    builderApiPassphrase: parsed.BUILDER_API_PASSPHRASE,
    builderApiKey2: parsed.BUILDER_API_KEY_2,
    builderApiSecret2: parsed.BUILDER_API_SECRET_2,
    builderApiPassphrase2: parsed.BUILDER_API_PASSPHRASE_2,
    builderSignerUrl: parsed.BUILDER_SIGNER_URL,
    builderSignerToken: parsed.BUILDER_SIGNER_TOKEN,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramChatId: parsed.TELEGRAM_CHAT_ID,
    marketSlugPrefix: parsed.MARKET_SLUG_PREFIX,
    marketIntervalSeconds: parsed.MARKET_INTERVAL_SECONDS,
    orderPrice: parsed.ORDER_PRICE,
    orderSize: parsed.ORDER_SIZE,
    positionEqualityTolerance: parsed.POSITION_EQUALITY_TOLERANCE,
    forceSellThresholdSeconds: parsed.FORCE_SELL_THRESHOLD_SECONDS,
    loopSleepSeconds: parsed.LOOP_SLEEP_SECONDS,
    currentLoopSleepSeconds: parsed.CURRENT_LOOP_SLEEP_SECONDS,
    redeemLoopSleepSeconds: parsed.REDEEM_LOOP_SLEEP_SECONDS,
    redeemEnabled: parsed.REDEEM_ENABLED,
    redeemMaxRetries: parsed.REDEEM_MAX_RETRIES,
    redeemRetryBackoffMs: parsed.REDEEM_RETRY_BACKOFF_MS,
    redeemSuccessCooldownMs: parsed.REDEEM_SUCCESS_COOLDOWN_MS,
    redeemMaxPerLoop: parsed.REDEEM_MAX_PER_LOOP,
    redeemTerminalStateTtlMs: parsed.REDEEM_TERMINAL_STATE_TTL_MS,
    positionRecheckSeconds: parsed.POSITION_RECHECK_SECONDS,
    entryReconcileSeconds: parsed.ENTRY_RECONCILE_SECONDS,
    entryReconcilePollSeconds: parsed.ENTRY_RECONCILE_POLL_SECONDS,
    entryCancelOpenOrders: parsed.ENTRY_CANCEL_OPEN_ORDERS,
    forceWindowFeeBuffer: parsed.FORCE_WINDOW_FEE_BUFFER,
    forceWindowMinProfitPerShare: parsed.FORCE_WINDOW_MIN_PROFIT_PER_SHARE,
    entryContinuousRepriceEnabled: parsed.ENTRY_CONTINUOUS_REPRICE_ENABLED,
    entryContinuousRepriceIntervalMs: parsed.ENTRY_CONTINUOUS_REPRICE_INTERVAL_MS,
    entryContinuousMinPriceDelta: parsed.ENTRY_CONTINUOUS_MIN_PRICE_DELTA,
    entryContinuousMaxDurationSeconds: parsed.ENTRY_CONTINUOUS_MAX_DURATION_SECONDS,
    entryContinuousMakerOffset: parsed.ENTRY_CONTINUOUS_MAKER_OFFSET,
    entryRecoveryHorizonSeconds: parsed.ENTRY_RECOVERY_HORIZON_SECONDS,
    entryRecoveryExtraProfitMax: parsed.ENTRY_RECOVERY_EXTRA_PROFIT_MAX,
    entryRecoveryMinSizeFraction: parsed.ENTRY_RECOVERY_MIN_SIZE_FRACTION,
    entryRecoveryPassiveOffsetMax: parsed.ENTRY_RECOVERY_PASSIVE_OFFSET_MAX,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    requestRetries: parsed.REQUEST_RETRIES,
    requestRetryBackoffMs: parsed.REQUEST_RETRY_BACKOFF_MS,
    stateFilePath: parsed.STATE_FILE_PATH,
    logLevel: parsed.LOG_LEVEL,
  };
};
