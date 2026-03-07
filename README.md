# Polymarket BTC 5-Minute Trading Bot

TypeScript trading bot for Polymarket BTC 5-minute up/down markets with safe-mode defaults.

## Current Status

- TypeScript implementation lives in `ts-src/`
- Legacy Python files are kept temporarily for migration safety
- Bot defaults to safe mode (`DRY_RUN=true`)

## Quick Start (TypeScript)

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Start bot in safe mode (default):

```bash
npm run bot
```

## Safety Model

- `DRY_RUN=true` means order and relayer writes are simulated only
- Live execution requires both:
  - `DRY_RUN=false`
  - `ENABLE_LIVE_TRADING=true`

If the flags are inconsistent, startup fails fast.

## Profitability Guard (EV)

The bot includes an EV guard that blocks new paired entries when expected value is too low.

- Formula used per share:
  - `net = 1 - (yesPrice + noPrice) - estimatedCosts`
- Price source:
  - Uses live CLOB midpoint prices for YES/NO tokens when available
  - Falls back to `ORDER_PRICE` if live prices are unavailable
- Estimated costs are configured by:
  - `EV_ESTIMATED_FEE_BPS`
  - `EV_ESTIMATED_SLIPPAGE_PER_SHARE`
  - `EV_ESTIMATED_FORCE_SELL_PENALTY_PER_SHARE`
  - `EV_ESTIMATED_PARTIAL_FILL_PENALTY_PER_SHARE`
- Entry is allowed only if:
  - `net >= EV_MIN_NET_PER_SHARE`

Config flags:

- `EV_GUARD_ENABLED=true`
- `EV_MIN_NET_PER_SHARE=0.01`

## Scripts

- `npm run bot` - run once in normal mode
- `npm run dev` - run with watch mode
- `npm run typecheck` - TypeScript type checks
- `npm run test` - run test suite
- `npm run build` - compile to `dist-ts/`

## Core TypeScript Modules

- Entry point: `ts-src/main.ts`
- Orchestration loop: `ts-src/bot.ts`
- Env validation: `ts-src/config/env.ts`
- CLOB adapter: `ts-src/clients/clobClient.ts`
- Relayer adapter: `ts-src/clients/relayerClient.ts`
- Gamma + data API clients: `ts-src/clients/gammaClient.ts`, `ts-src/clients/dataClient.ts`
- Market logic: `ts-src/services/marketDiscovery.ts`
- Position logic: `ts-src/services/positionManager.ts`
- Trading + settlement: `ts-src/services/tradingEngine.ts`, `ts-src/services/settlement.ts`
- EV filter: `ts-src/services/evGuard.ts`

## Configuration

Use `.env.example` for all supported variables. Key values:

- `PRIVATE_KEY` (required)
- `CHAIN_ID` (`137` or `80002`)
- `CLOB_API_HOST`, `GAMMA_API_BASE_URL`, `DATA_API_BASE_URL`
- `ORDER_PRICE`, `ORDER_SIZE`
- `FORCE_SELL_THRESHOLD_SECONDS`, `POSITION_EQUALITY_TOLERANCE`
- `MIN_SECONDS_TO_CLOSE_FOR_ENTRY` (skip new entries near market end)
- Optional relayer: `POLYMARKET_RELAYER_URL`, `POLYGON_RPC`

## Workflow

Detailed roadmap and intended strategy are documented in `WORKFLOW.md`.
