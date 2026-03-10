import { Config, Effect, Option, pipe } from "effect";
import type { BotConfig } from "../types/domain.js";

const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

const parseBooleanString = (name: string, defaultValue?: boolean): Config.Config<boolean> => {
  const base = pipe(
    Config.string(name),
    Config.mapAttempt((value) => {
      const normalized = value.trim().toLowerCase();
      if (normalized !== "true" && normalized !== "false") {
        throw new Error(`${name} must be true or false`);
      }
      return normalized === "true";
    }),
  );

  return defaultValue === undefined ? base : Config.withDefault(base, defaultValue);
};

const parseUrlString = (name: string, defaultValue?: string): Config.Config<string> => {
  const base = pipe(
    Config.string(name),
    Config.mapAttempt((value) => {
      const trimmed = value.trim();
      new URL(trimmed);
      return trimmed;
    }),
  );

  return defaultValue === undefined ? base : Config.withDefault(base, defaultValue);
};

const parseNumberBounded = (params: {
  name: string;
  defaultValue?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  label?: string;
}): Config.Config<number> => {
  const base = pipe(
    Config.number(params.name),
    Config.mapAttempt((value) => {
      if (params.integer && !Number.isInteger(value)) {
        throw new Error(`${params.name} must be an integer`);
      }
      if (params.min !== undefined && value < params.min) {
        throw new Error(`${params.name} must be >= ${params.min}`);
      }
      if (params.max !== undefined && value > params.max) {
        throw new Error(`${params.name} must be <= ${params.max}`);
      }
      return value;
    }),
  );

  return params.defaultValue === undefined ? base : Config.withDefault(base, params.defaultValue);
};

const optionalString = (name: string): Config.Config<string | undefined> =>
  pipe(
    Config.option(Config.string(name)),
    Config.map((value) => Option.getOrUndefined(value)),
  );

const optionalUrlString = (name: string): Config.Config<string | undefined> =>
  pipe(
    Config.option(parseUrlString(name)),
    Config.map((value) => Option.getOrUndefined(value)),
  );

const configSchema = Config.all({
  dryRun: parseBooleanString("DRY_RUN", true),
  privateKey: pipe(
    Config.string("PRIVATE_KEY"),
    Config.mapAttempt((value) => {
      if (!PRIVATE_KEY_REGEX.test(value)) {
        throw new Error("PRIVATE_KEY must be 0x + 64 hex characters");
      }
      return value as `0x${string}`;
    }),
  ),
  funder: pipe(
    Config.option(Config.string("FUNDER")),
    Config.mapAttempt((value) => {
      if (Option.isNone(value)) {
        return undefined;
      }

      if (!ADDRESS_REGEX.test(value.value)) {
        throw new Error("FUNDER must be a valid 0x-prefixed address");
      }

      return value.value as `0x${string}`;
    }),
  ),
  signatureType: pipe(
    parseNumberBounded({ name: "SIGNATURE_TYPE", defaultValue: 0, min: 0, max: 2, integer: true }),
    Config.map((value) => value as 0 | 1 | 2),
  ),
  chainId: pipe(
    parseNumberBounded({ name: "CHAIN_ID", defaultValue: 137, integer: true }),
    Config.mapAttempt((value) => {
      if (value !== 137 && value !== 80002) {
        throw new Error("CHAIN_ID must be 137 or 80002");
      }
      return value as 137 | 80002;
    }),
  ),
  clobApiHost: parseUrlString("CLOB_API_HOST", "https://clob.polymarket.com"),
  clobWsUrl: parseUrlString("CLOB_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  enableClobWs: parseBooleanString("ENABLE_CLOB_WS", true),
  wsQuotesMaxAgeMs: parseNumberBounded({ name: "WS_QUOTES_MAX_AGE_MS", defaultValue: 2000, min: 1, integer: true }),
  wsReconnectDelayMs: parseNumberBounded({ name: "WS_RECONNECT_DELAY_MS", defaultValue: 2000, min: 1, integer: true }),
  gammaApiBaseUrl: parseUrlString("GAMMA_API_BASE_URL", "https://gamma-api.polymarket.com"),
  dataApiBaseUrl: parseUrlString("DATA_API_BASE_URL", "https://data-api.polymarket.com"),
  polygonRpc: optionalUrlString("POLYGON_RPC"),
  polymarketRelayerUrl: optionalUrlString("POLYMARKET_RELAYER_URL"),
  builderApiKey: optionalString("BUILDER_API_KEY"),
  builderApiSecret: optionalString("BUILDER_API_SECRET"),
  builderApiPassphrase: optionalString("BUILDER_API_PASSPHRASE"),
  builderApiKey2: optionalString("BUILDER_API_KEY_2"),
  builderApiSecret2: optionalString("BUILDER_API_SECRET_2"),
  builderApiPassphrase2: optionalString("BUILDER_API_PASSPHRASE_2"),
  builderSignerUrl: optionalUrlString("BUILDER_SIGNER_URL"),
  builderSignerToken: optionalString("BUILDER_SIGNER_TOKEN"),
  telegramBotToken: optionalString("TELEGRAM_BOT_TOKEN"),
  telegramChatId: optionalString("TELEGRAM_CHAT_ID"),
  marketSlugPrefix: Config.withDefault(Config.string("MARKET_SLUG_PREFIX"), "btc-updown-5m"),
  marketIntervalSeconds: parseNumberBounded({ name: "MARKET_INTERVAL_SECONDS", defaultValue: 300, min: 1, integer: true }),
  orderPrice: parseNumberBounded({ name: "ORDER_PRICE", defaultValue: 0.46, min: 0, max: 1 }),
  orderSize: parseNumberBounded({ name: "ORDER_SIZE", defaultValue: 5, min: 0.000001 }),
  positionEqualityTolerance: parseNumberBounded({ name: "POSITION_EQUALITY_TOLERANCE", defaultValue: 0.01, min: 0.000001 }),
  forceSellThresholdSeconds: parseNumberBounded({ name: "FORCE_SELL_THRESHOLD_SECONDS", defaultValue: 30, min: 1, integer: true }),
  loopSleepSeconds: parseNumberBounded({ name: "LOOP_SLEEP_SECONDS", defaultValue: 10, min: 1, integer: true }),
  currentLoopSleepSeconds: parseNumberBounded({ name: "CURRENT_LOOP_SLEEP_SECONDS", defaultValue: 3, min: 1, integer: true }),
  positionRecheckSeconds: parseNumberBounded({ name: "POSITION_RECHECK_SECONDS", defaultValue: 60, min: 1, integer: true }),
  entryReconcileSeconds: parseNumberBounded({ name: "ENTRY_RECONCILE_SECONDS", defaultValue: 15, min: 1, integer: true }),
  entryReconcilePollSeconds: parseNumberBounded({ name: "ENTRY_RECONCILE_POLL_SECONDS", defaultValue: 3, min: 1, integer: true }),
  entryCancelOpenOrders: parseBooleanString("ENTRY_CANCEL_OPEN_ORDERS", true),
  entryMaxRepriceAttempts: parseNumberBounded({ name: "ENTRY_MAX_REPRICE_ATTEMPTS", defaultValue: 2, min: 0, integer: true }),
  entryRepriceStep: parseNumberBounded({ name: "ENTRY_REPRICE_STEP", defaultValue: 0.01, min: 0.000001 }),
  entryMaxPrice: parseNumberBounded({ name: "ENTRY_MAX_PRICE", defaultValue: 0.5, min: 0, max: 1 }),
  entryMaxSpread: parseNumberBounded({ name: "ENTRY_MAX_SPREAD", defaultValue: 0.03, min: 0.000001 }),
  entryDepthPriceBand: parseNumberBounded({ name: "ENTRY_DEPTH_PRICE_BAND", defaultValue: 0.02, min: 0.000001 }),
  entryDepthUsageRatio: parseNumberBounded({ name: "ENTRY_DEPTH_USAGE_RATIO", defaultValue: 0.6, min: 0.000001, max: 1 }),
  forceWindowFeeBuffer: parseNumberBounded({ name: "FORCE_WINDOW_FEE_BUFFER", defaultValue: 0.01, min: 0 }),
  forceWindowMinProfitPerShare: parseNumberBounded({ name: "FORCE_WINDOW_MIN_PROFIT_PER_SHARE", defaultValue: 0.005, min: 0 }),
  entryContinuousRepriceEnabled: parseBooleanString("ENTRY_CONTINUOUS_REPRICE_ENABLED", true),
  entryContinuousRepriceIntervalMs: parseNumberBounded({
    name: "ENTRY_CONTINUOUS_REPRICE_INTERVAL_MS",
    defaultValue: 1500,
    min: 1,
    integer: true,
  }),
  entryContinuousMinPriceDelta: parseNumberBounded({ name: "ENTRY_CONTINUOUS_MIN_PRICE_DELTA", defaultValue: 0.002, min: 0.000001 }),
  entryContinuousMaxDurationSeconds: parseNumberBounded({
    name: "ENTRY_CONTINUOUS_MAX_DURATION_SECONDS",
    defaultValue: 45,
    min: 1,
    integer: true,
  }),
  entryContinuousMakerOffset: parseNumberBounded({ name: "ENTRY_CONTINUOUS_MAKER_OFFSET", defaultValue: 0.001, min: 0 }),
  requestTimeoutMs: parseNumberBounded({ name: "REQUEST_TIMEOUT_MS", defaultValue: 30000, min: 1, integer: true }),
  requestRetries: parseNumberBounded({ name: "REQUEST_RETRIES", defaultValue: 3, min: 0, integer: true }),
  requestRetryBackoffMs: parseNumberBounded({ name: "REQUEST_RETRY_BACKOFF_MS", defaultValue: 500, min: 0, integer: true }),
  stateFilePath: Config.withDefault(Config.string("STATE_FILE_PATH"), ".bot-state.json"),
  logLevel: Config.withDefault(
    Config.literal("fatal", "error", "warn", "info", "debug", "trace")("LOG_LEVEL"),
    "info",
  ),
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

export const loadEffectConfig = (): BotConfig => {
  const parsed = Effect.runSync(configSchema);

  assertCompleteBuilderCreds("primary builder credentials", {
    key: parsed.builderApiKey,
    secret: parsed.builderApiSecret,
    passphrase: parsed.builderApiPassphrase,
  });

  assertCompleteBuilderCreds("secondary builder credentials", {
    key: parsed.builderApiKey2,
    secret: parsed.builderApiSecret2,
    passphrase: parsed.builderApiPassphrase2,
  });

  return parsed;
};
