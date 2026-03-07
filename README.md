# Polymarket BTC 5-Minute Trading Bot

TypeScript trading bot for Polymarket BTC 5-minute up/down markets with safe-mode defaults.

## Current Status

- TypeScript implementation lives in `src/`
- Bot defaults to safe mode (`DRY_RUN=true`)

## Quick Start (TypeScript)

1. Install dependencies:

```bash
bun install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Start bot in safe mode (default):

```bash
bun run bot
```

## Safety Model

- `DRY_RUN=true` means order and relayer writes are simulated only
- `DRY_RUN=false` enables live execution

## Scripts

- `bun run bot` - run once in normal mode
- `bun run dev` - run with watch mode
- `bun run typecheck` - TypeScript type checks
- `bun run test` - run test suite
- `bun run build` - compile to `dist-ts/`

## Core TypeScript Modules

- Entry point: `src/main.ts`
- Orchestration loop: `src/bot.ts`
- Env validation: `src/config/env.ts`
- CLOB adapter: `src/clients/clobClient.ts`
- Relayer adapter: `src/clients/relayerClient.ts`
- Gamma + data API clients: `src/clients/gammaClient.ts`, `src/clients/dataClient.ts`
- Market logic: `src/services/marketDiscovery.ts`
- Position logic: `src/services/positionManager.ts`
- Trading + settlement: `src/services/tradingEngine.ts`, `src/services/settlement.ts`

## Configuration

Use `.env.example` for all supported variables. Key values:

- `PRIVATE_KEY` (required)
- `CHAIN_ID` (`137` or `80002`)
- `CLOB_API_HOST`, `GAMMA_API_BASE_URL`, `DATA_API_BASE_URL`
- `ORDER_PRICE`, `ORDER_SIZE`
- `FORCE_SELL_THRESHOLD_SECONDS`, `POSITION_EQUALITY_TOLERANCE`
- `STATE_FILE_PATH` (persist one-pair-per-market state across restarts)
- `FUNDER` (optional; used as positions address when set)
- Optional relayer: `POLYMARKET_RELAYER_URL`, `POLYGON_RPC`

## Workflow

Detailed roadmap and intended strategy are documented in `WORKFLOW.md`.
