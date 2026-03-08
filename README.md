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
- `GAMMA_API_BASE_URL=https://gamma-api.polymarket.com`
- `DATA_API_BASE_URL=https://data-api.polymarket.com`
- `MARKET_SLUG_PREFIX=btc-updown-5m`
- `MARKET_INTERVAL_SECONDS=300`
- `ORDER_PRICE=0.46`
- `ORDER_SIZE=5`
- `POSITION_EQUALITY_TOLERANCE=0.01`
- `FORCE_SELL_THRESHOLD_SECONDS=30`
- `LOOP_SLEEP_SECONDS=10`
- `POSITION_RECHECK_SECONDS=60`
- `REQUEST_TIMEOUT_MS=30000`
- `REQUEST_RETRIES=3`
- `REQUEST_RETRY_BACKOFF_MS=500`
- `STATE_FILE_PATH=.bot-state.json`

Optional:

- `FUNDER` (when set, used as the positions address instead of signer address)
- `POLYMARKET_RELAYER_URL`, `POLYGON_RPC` (both required to enable relayer)

Optional relayer builder auth:

- Local creds: `BUILDER_API_KEY`, `BUILDER_API_SECRET`, `BUILDER_API_PASSPHRASE` (must all be set together)
- Remote signer: `BUILDER_SIGNER_URL` (+ optional `BUILDER_SIGNER_TOKEN`)

## Safety and state

- Dry run returns intents for all write operations (CLOB + relayer).
- Entered market condition IDs are persisted to `STATE_FILE_PATH`.
- Persisted state prevents multiple paired entries into the same condition across restarts.

## Workflow

The implementation-accurate runtime flow is documented in `WORKFLOW.md`.
