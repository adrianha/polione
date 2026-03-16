import { loadConfig } from "../config/env.js";
import { PolyClobClient } from "../clients/clobClient.js";
import { GammaClient } from "../clients/gammaClient.js";
import { DataClient } from "../clients/dataClient.js";
import { TradingEngine } from "../services/tradingEngine.js";
import { getCurrentEpochTimestamp, unixNow } from "../utils/time.js";
import type { MarketRecord, TokenIds } from "../types/domain.js";

const buildSlug = (prefix: string, epochSec: number): string => `${prefix}-${epochSec}`;

const parseClobTokenIds = (raw: unknown): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
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
      return { upTokenId: tokenA.token_id, downTokenId: tokenB.token_id };
    }
  }
  return null;
};

const parseArgs = (): { count: number } => {
  const args = process.argv.slice(2);
  let count = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--count" || args[i] === "-n") {
      const val = Number(args[i + 1]);
      if (Number.isInteger(val) && val > 0) {
        count = val;
      }
    }
  }

  return { count };
};

const main = async () => {
  const { count } = parseArgs();
  console.log(`Placing limit orders for next ${count} BTC 5m updown markets...`);

  const config = loadConfig();
  const clobClient = new PolyClobClient(config);
  const gammaClient = new GammaClient(config);
  const dataClient = new DataClient(config);
  const tradingEngine = new TradingEngine(config, clobClient, dataClient);

  await clobClient.init();

  const now = unixNow();
  const currentEpoch = getCurrentEpochTimestamp(now, config.marketIntervalSeconds);

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  for (let i = 1; i <= count; i++) {
    const targetEpoch = currentEpoch + i * config.marketIntervalSeconds;
    const slug = buildSlug(config.marketSlugPrefix, targetEpoch);

    console.log(`\n[${i}/${count}] Checking market: ${slug}`);

    let market: MarketRecord | null;
    try {
      market = await gammaClient.getMarketBySlug(slug);
    } catch (err) {
      console.log(`  -> Error fetching market: ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
      continue;
    }

    if (!market) {
      console.log(`  -> Market not found (not created yet)`);
      skippedCount++;
      continue;
    }

    const tokenIds = parseTokens(market);
    if (!tokenIds) {
      console.log(`  -> Could not parse token IDs from market`);
      failCount++;
      continue;
    }

    const orderPrice = 0.01;
    const orderSize = 5;

    console.log(`  -> Placing paired limit orders: ${orderSize} shares @ $${orderPrice}`);
    console.log(`  -> UP token: ${tokenIds.upTokenId}`);
    console.log(`  -> DOWN token: ${tokenIds.downTokenId}`);

    try {
      const result = await tradingEngine.placePairedLimitBuysAtPrice(
        tokenIds,
        orderPrice,
        orderSize,
      );

      const upOrderId = tradingEngine.extractOrderId(result.up);
      const downOrderId = tradingEngine.extractOrderId(result.down);

      console.log(`  -> UP order ID: ${upOrderId ?? "N/A"}`);
      console.log(`  -> DOWN order ID: ${downOrderId ?? "N/A"}`);
      successCount++;
    } catch (err) {
      console.log(`  -> Error placing orders: ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Summary:`);
  console.log(`  Success: ${successCount}`);
  console.log(`  Failed:  ${failCount}`);
  console.log(`  Skipped: ${skippedCount} (markets not yet created)`);
  console.log(`========================================`);
};

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
