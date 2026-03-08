# Workflow and Runtime Logic

This document describes the workflow currently implemented in the TypeScript bot.

## High-level execution flow

```text
START
  |
  v
Load/validate config (src/config/env.ts)
  |
  v
Construct bot + clients/services (src/bot.ts)
  |
  v
Init CLOB credentials (clobClient.init)
  |
  v
Load persisted entered market state (STATE_FILE_PATH)
  |
  v
MAIN LOOP (until stop signal)
  |
  +--> Discover current market + next market
  |      - findCurrentActiveMarket()
  |      - findNextActiveMarket()
  |
  +--> If no market found: sleep LOOP_SLEEP_SECONDS, continue
  |
  +--> If current market is an entered market:
  |      - fetch positions for current condition
  |      - summarize UP/DOWN sizes and difference
  |      - compute equality + seconds to close
  |      - decision:
  |          A) equal + relayer available + not merge-attempted -> merge
  |          B) not equal + near close (<= FORCE_SELL_THRESHOLD_SECONDS) -> force sell
  |
  +--> Select entry market from next market
  |      - must be distinct from current condition
  |
  +--> Entry guards (skip cycle if any fail):
  |      - token IDs exist
  |      - condition ID exists
  |      - condition not already in entered state
  |      - no existing position exposure in candidate market
  |      - sufficient USDC for both legs (ORDER_PRICE * ORDER_SIZE * 2)
  |
  +--> Place paired limit buys (UP + DOWN)
  |      - reconcile fills for ENTRY_RECONCILE_SECONDS
  |      - if imbalanced: reprice paired entry (bounded attempts)
  |      - final attempt fallback: optional cancel open entry orders, flatten exposure
  |      - if balanced: persist entered condition ID, sleep POSITION_RECHECK_SECONDS
  |
  +--> On skip or loop-level error: sleep LOOP_SLEEP_SECONDS
  |
  `--> repeat
```

## Phase details

### 1) Startup

- `src/main.ts` loads config and creates logger.
- `src/main.ts` creates `PolymarketBot` and registers SIGINT/SIGTERM handlers.
- `src/bot.ts` initializes CLOB API credentials before entering the loop.
- `src/bot.ts` resolves addresses:
  - signer address from CLOB wallet
  - positions address = `FUNDER` when provided, otherwise signer address
- `src/bot.ts` loads persisted entered market condition IDs from `STATE_FILE_PATH`.

### 2) Market discovery

- `src/services/marketDiscovery.ts` is used each cycle to find:
  - current active market for current epoch
  - next active market (next epoch first, then current fallback)
- If both are missing, the bot logs and sleeps `LOOP_SLEEP_SECONDS`.

### 3) Current entered market management

This block runs only when the current market condition is already in the entered set.

- Fetch positions via `src/clients/dataClient.ts` for current condition.
- Summarize with `summarizePositions` and compare with `arePositionsEqual` from `src/services/positionManager.ts`.
- Compute time to close via market discovery service.
- Decision logic:
  - Merge path:
    - conditions: positions are equal, UP size > 0, relayer available, merge not attempted for this condition
    - action: `SettlementService.mergeEqualPositions(...)`
    - note: merge attempts are tracked in-memory by condition (`mergeAttemptedMarkets`) and are not retried again in the same process once attempted
  - Force-sell path:
    - conditions: positions are not equal and time to close <= `FORCE_SELL_THRESHOLD_SECONDS`
    - action: `TradingEngine.forceSellAll(...)`

### 4) New entry evaluation

- Candidate entry market is the discovered next market.
- If next market has the same condition ID as current market, entry is skipped for this cycle.
- Required market metadata checks:
  - token IDs must exist
  - condition ID must exist
- Skip if condition already exists in persisted entered state.

Exposure guard before placing new paired orders:

- Bot fetches current positions for the candidate condition.
- If any exposure already exists (UP > 0 or DOWN > 0), bot skips entry.
- Additional close-to-expiry cleanup from this guard:
  - if exposure is imbalanced and near close, force-sell is triggered from the entry guard path.

Balance guard before placing new paired orders:

- Required USDC = `ORDER_PRICE * ORDER_SIZE * 2`
- If balance is insufficient, entry is skipped for this cycle.

If all guards pass:

- Place paired limit BUY orders for UP and DOWN via `TradingEngine.placePairedLimitBuys(...)`.
- Before each entry attempt, run liquidity gate from order books:
  - spread cap: `ENTRY_MAX_SPREAD`
  - depth band above entry price: `ENTRY_DEPTH_PRICE_BAND`
  - depth usage ratio for adaptive order size: `ENTRY_DEPTH_USAGE_RATIO`
  - minimum acceptable adaptive size: `ORDER_SIZE`
- Reconcile fill status via `TradingEngine.reconcilePairedEntry(...)` for `ENTRY_RECONCILE_SECONDS`.
- If imbalanced, retry paired entry at incrementally higher bounded price levels:
  - max retries: `ENTRY_MAX_REPRICE_ATTEMPTS`
  - step size: `ENTRY_REPRICE_STEP`
  - hard cap: `ENTRY_MAX_PRICE`
- Near market close (`secondsToClose <= FORCE_SELL_THRESHOLD_SECONDS`), repricing attempts are disabled and final fallback is prioritized.
- Inside force-sell window, if entry is imbalanced:
  - cancel open entry orders first,
  - evaluate missing-leg best ask against profitable hedge threshold:
    - `maxHedgePrice = 1 - filledLegAvgPrice - FORCE_WINDOW_FEE_BUFFER - FORCE_WINDOW_MIN_PROFIT_PER_SHARE`
  - if profitable, complete missing leg and re-check balance,
  - if not profitable (or still imbalanced), flatten filled exposure.
- If balanced within tolerance:
  - Persist condition ID in entered market state (`STATE_FILE_PATH`).
  - Sleep `POSITION_RECHECK_SECONDS`.
- If final attempt remains imbalanced at reconcile timeout:
  - Optionally cancel open entry orders for both legs (`ENTRY_CANCEL_OPEN_ORDERS=true`).
  - Flatten residual exposure with existing market-sell behavior.
  - Do not persist entered condition ID for that cycle.

### 5) Loop error handling and retry behavior

- Loop body is wrapped in `try/catch`.
- Any loop-level error is logged; process continues after sleeping `LOOP_SLEEP_SECONDS`.
- Current entered-market management loop runs on `CURRENT_LOOP_SLEEP_SECONDS` cadence.
- HTTP/API call retries use configurable retry settings:
  - `REQUEST_RETRIES`
  - `REQUEST_RETRY_BACKOFF_MS`
  - `REQUEST_TIMEOUT_MS`

## Safety model

- `DRY_RUN=true` (default):
  - CLOB write operations return dry-run intents instead of posting orders/cancels.
  - Relayer write operations return dry-run intents instead of broadcasting transactions.
- `DRY_RUN=false`: executes live writes.

## Relayer and settlement behavior

- Relayer client is enabled only when both are set:
  - `POLYMARKET_RELAYER_URL`
  - `POLYGON_RPC`
- Optional builder auth modes:
  - Local credentials (`BUILDER_API_KEY`, `BUILDER_API_SECRET`, `BUILDER_API_PASSPHRASE`) must be fully provided as a set.
  - Remote signer (`BUILDER_SIGNER_URL`, optional `BUILDER_SIGNER_TOKEN`).
- Active loop uses merge (`mergeEqualPositions`) when conditions are met.
- Redeem capability exists in client/service (`redeemPositions` / `redeemResolvedPositions`) but is not called in the current main bot loop.

## State persistence

- Entered market condition IDs are persisted in `STATE_FILE_PATH`.
- On startup, state is reloaded to avoid duplicate paired entries after restart.

## Notes on behavior differences from older docs

- No hard process stop on low USDC; entry is skipped and loop continues.
- Sleep durations are config-driven (`LOOP_SLEEP_SECONDS`, `POSITION_RECHECK_SECONDS`), not fixed constants in docs.
- Current implementation uses one global cycle with guard checks, not a separate nested perpetual per-market monitor loop.
