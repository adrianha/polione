import { z } from "zod";

const boolString = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ["true", "false"].includes(value), {
    message: "must be true or false",
  })
  .transform((value) => value === "true");

const parseIntervalFromSlug = (slugPrefix: string): number => {
  const match = slugPrefix.match(/(\d+)([mh])$/i);
  if (!match) {
    throw new Error(`Cannot parse interval from slug prefix: ${slugPrefix}. Expected format like "btc-updown-5m" or "eth-updown-15m"`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 3600;
  throw new Error(`Unknown interval unit: ${unit}`);
};

const schema = z.object({
  V5_SLUG_PREFIX: z.string().default("sol-updown-5m"),
  V5_ENTRY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  V5_MAX_ENTRY_PRICE: z.coerce.number().min(0).max(1).default(0.90),
  V5_TAKE_PROFIT_PRICE: z.coerce.number().min(0).max(1).default(0.95),
  V5_STOP_LOSS_PRICE: z.coerce.number().min(0).max(1).default(0.60),
  V5_TRAILING_TP: boolString.default(false),
  V5_TRAILING_TP_ACTIVATION: z.coerce.number().min(0).max(1).default(0.95),
  V5_MAX_USDC_PER_TRADE: z.coerce.number().positive().default(1),
  V5_MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(1),
  V5_LOOP_INTERVAL_SECONDS: z.coerce.number().positive().default(1),
  V5_ORDER_FILL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  V5_ORDER_FILL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  V5_STATE_FILE_PATH: z.string().default(".bot-v5-state.json"),
  V5_REDEEM_ENABLED: boolString.default(true),
  V5_REDEEM_MAX_RETRIES: z.coerce.number().int().positive().default(8),
  V5_REDEEM_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
});

export interface V5Config {
  slugPrefix: string;
  marketIntervalSeconds: number;
  entryThreshold: number;
  maxEntryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  trailingTp: boolean;
  trailingTpActivation: number;
  maxUsdcPerTrade: number;
  maxOpenPositions: number;
  loopIntervalSeconds: number;
  orderFillTimeoutMs: number;
  orderFillPollIntervalMs: number;
  stateFilePath: string;
  redeemEnabled: boolean;
  redeemMaxRetries: number;
  redeemIntervalSeconds: number;
}

export const loadV5Config = (): V5Config => {
  const parsed = schema.parse(process.env);

  if (!parsed.V5_SLUG_PREFIX.trim()) {
    throw new Error("V5_SLUG_PREFIX must not be empty");
  }

  return {
    slugPrefix: parsed.V5_SLUG_PREFIX.trim(),
    marketIntervalSeconds: parseIntervalFromSlug(parsed.V5_SLUG_PREFIX.trim()),
    entryThreshold: parsed.V5_ENTRY_THRESHOLD,
    maxEntryPrice: parsed.V5_MAX_ENTRY_PRICE,
    takeProfitPrice: parsed.V5_TAKE_PROFIT_PRICE,
    stopLossPrice: parsed.V5_STOP_LOSS_PRICE,
    trailingTp: parsed.V5_TRAILING_TP,
    trailingTpActivation: parsed.V5_TRAILING_TP_ACTIVATION,
    maxUsdcPerTrade: parsed.V5_MAX_USDC_PER_TRADE,
    maxOpenPositions: parsed.V5_MAX_OPEN_POSITIONS,
    loopIntervalSeconds: parsed.V5_LOOP_INTERVAL_SECONDS,
    orderFillTimeoutMs: parsed.V5_ORDER_FILL_TIMEOUT_MS,
    orderFillPollIntervalMs: parsed.V5_ORDER_FILL_POLL_INTERVAL_MS,
    stateFilePath: parsed.V5_STATE_FILE_PATH,
    redeemEnabled: parsed.V5_REDEEM_ENABLED,
    redeemMaxRetries: parsed.V5_REDEEM_MAX_RETRIES,
    redeemIntervalSeconds: parsed.V5_REDEEM_INTERVAL_SECONDS,
  };
};
