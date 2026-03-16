# Polymarket BTC 5-Minute Trading Bot

TypeScript trading bot for Polymarket BTC 5-minute up/down markets with safe-mode defaults.

## What it does

- Discovers the current and next BTC 5-minute market epochs.
- Places paired limit BUY orders (UP and DOWN) on eligible next markets.
- Monitors entered current markets and manages open exposure.
- Merges equal UP/DOWN positions through the relayer when available.
- Force-sells imbalanced positions near market close.

## Run modes

- `DRY_RUN=true` (default): simulates CLOB and relayer writes and logs intent payloads.
- `DRY_RUN=false`: enables live order placement and relayer transactions.

## Quick start

1. Install dependencies:

```bash
bun install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Start in safe mode (default):

```bash
bun run dev
```

4. Optional PM2 process start:

```bash
bun run bot
```

## Scripts

- `bun run dev` - run `src/main.ts` in watch mode.
- `bun run bot` - start PM2 using `pm2.config.js`.
- `bun run build` - compile TypeScript to `dist/`.
- `bun run typecheck` - run TypeScript checks without emit.
- `bun run test` - run tests with Vitest.
- `bun run fmt` - format code with `oxfmt`.
- `bun run fmt:check` - check formatting with `oxfmt --check`.

## Implementation map

- Entry point: `src/main.ts`
- Main orchestration loop: `src/bot.ts`
- Env parsing and validation: `src/config/env.ts`
- CLOB adapter: `src/clients/clobClient.ts`
- Relayer adapter: `src/clients/relayerClient.ts`
- Market + positions APIs: `src/clients/gammaClient.ts`, `src/clients/dataClient.ts`
- Services: `src/services/marketDiscovery.ts`, `src/services/positionManager.ts`, `src/services/tradingEngine.ts`, `src/services/settlement.ts`
- State persistence: `src/utils/stateStore.ts`

## Configuration

Use `.env.example` as the source of truth for supported variables.

Required:

- `PRIVATE_KEY`

Common defaults:

- `DRY_RUN=true`
- `CHAIN_ID=137`
- `CLOB_API_HOST=https://clob.polymarket.com`
- `CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market`
- `ENABLE_CLOB_WS=true`
- `WS_QUOTES_MAX_AGE_MS=2000`
- `WS_RECONNECT_DELAY_MS=2000`
- `GAMMA_API_BASE_URL=https://gamma-api.polymarket.com`
- `DATA_API_BASE_URL=https://data-api.polymarket.com`
- `MARKET_SLUG_PREFIX=btc-updown-5m`
- `MARKET_INTERVAL_SECONDS=300`
- `ORDER_PRICE=0.46`
- `ORDER_SIZE=5`
- `POSITION_EQUALITY_TOLERANCE=0.01`
- `FORCE_SELL_THRESHOLD_SECONDS=30`
- `MARKET_POLL_MS=10000`
- `MARKET_URGENT_POLL_MS=3000`
- `REDEEM_POLL_MS=60000`
- `TELEGRAM_POLL_MS=10000`
- `ENTRY_RECONCILE_SECONDS=15`
- `ENTRY_RECONCILE_POLL_SECONDS=3`
- `ENTRY_CANCEL_OPEN_ORDERS=true`
- `FORCE_WINDOW_FEE_BUFFER=0.01`
- `FORCE_WINDOW_MIN_PROFIT_PER_SHARE=0.005`
- `ENTRY_CONTINUOUS_REPRICE_ENABLED=true`
- `ENTRY_CONTINUOUS_REPRICE_INTERVAL_MS=1500`
- `ENTRY_CONTINUOUS_MIN_PRICE_DELTA=0.002`
- `ENTRY_CONTINUOUS_MAX_DURATION_SECONDS=45`
- `ENTRY_CONTINUOUS_MAKER_OFFSET=0.001`
- `ENTRY_RECOVERY_HORIZON_SECONDS=120`
- `ENTRY_RECOVERY_EXTRA_PROFIT_MAX=0.01`
- `ENTRY_RECOVERY_MIN_SIZE_FRACTION=0.35`
- `ENTRY_RECOVERY_PASSIVE_OFFSET_MAX=0.004`
- `REQUEST_TIMEOUT_MS=30000`
- `REQUEST_RETRIES=3`
- `REQUEST_RETRY_BACKOFF_MS=500`
- `STATE_FILE_PATH=.bot-state.json`

Optional:

- `FUNDER` (when set, used as the positions address instead of signer address)
- `POLYMARKET_RELAYER_URL`, `POLYGON_RPC` (both required to enable relayer)

Optional relayer builder auth:

- Local creds: `BUILDER_API_KEY`, `BUILDER_API_SECRET`, `BUILDER_API_PASSPHRASE` (must all be set together)
- Optional secondary local creds for failover: `BUILDER_API_KEY_2`, `BUILDER_API_SECRET_2`, `BUILDER_API_PASSPHRASE_2` (must all be set together)
- Remote signer: `BUILDER_SIGNER_URL` (+ optional `BUILDER_SIGNER_TOKEN`)

Optional notifications:

- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (Telegram notifications are enabled only when both are set)
- Telegram command support: send `/balance` or `/usdc` in the configured chat to receive current USDC balance.

## Safety and state

- Dry run returns intents for all write operations (CLOB + relayer).
- Tracked market condition IDs are persisted to `STATE_FILE_PATH`.
- Persisted state prevents multiple paired entries into the same condition across restarts.
- Direct current-market entries run an immediate entry reconciliation window.
- If a direct current-market entry remains imbalanced, the bot defers missing-leg recovery to tracked-current processing.
- Next-market entries are persisted immediately and left untouched until that market rolls into current.
- When a tracked market becomes current, `processTrackedCurrentMarket` is the only place that runs missing-leg recovery.
- Outside `FORCE_SELL_THRESHOLD_SECONDS`, tracked current markets can run continuous maker-first missing-leg recovery.
- Outside `FORCE_SELL_THRESHOLD_SECONDS`, missing-leg recovery uses a linear profitability-first curve: larger edge buffer, more passive quotes, and smaller size when far from close, relaxing as force window nears.
- Inside the force-sell window, bot can optionally complete the missing leg only when hedge price is profitable by configured fee/profit buffers; otherwise it cancels open orders and flattens the filled side.
- Entry execution now uses a liquidity/spread gate and adaptive order size derived from order book depth.
- Continuous missing-leg repricing (including force-window fallback) is handled in `processTrackedCurrentMarket`, not in `processEntryMarket`.
- Telegram notifications use rich text with truncated IDs for readability and include market details.
- Notifications are sent for non-success critical events and first successful paired placement per condition.
- Relayer failover can switch from primary local builder creds to secondary local builder creds on confirmed rate-limit errors only, and sends a one-time Telegram alert per failover episode.

## Workflow

The implementation-accurate runtime flow is documented in `WORKFLOW.md`.

## Profitability-first tuning

- `ENTRY_RECOVERY_HORIZON_SECONDS` defines how far from close the linear conservatism ramps to max.
- `ENTRY_RECOVERY_EXTRA_PROFIT_MAX` adds extra per-share profit target at far horizon (linearly decays to 0 near force window).
- `ENTRY_RECOVERY_MIN_SIZE_FRACTION` is the smallest recovery size fraction used at far horizon.
- `ENTRY_RECOVERY_PASSIVE_OFFSET_MAX` adds extra maker passiveness at far horizon (linearly decays to 0 near force window).

Suggested starting profile (profitability-first):

- `ENTRY_RECOVERY_HORIZON_SECONDS=120`
- `ENTRY_RECOVERY_EXTRA_PROFIT_MAX=0.01`
- `ENTRY_RECOVERY_MIN_SIZE_FRACTION=0.35`
- `ENTRY_RECOVERY_PASSIVE_OFFSET_MAX=0.004`
