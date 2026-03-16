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
Load persisted tracked market state (STATE_FILE_PATH)
  |
  v
SCHEDULER LOOP (until stop signal)
  |
  +--> Run market task
  |      - findCurrentActiveMarket()
  |      - findNextActiveMarket()
  |
  +--> If current market is a tracked market:
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
  |      - next-market entry: persist condition immediately and leave untouched until rollover
  |      - direct current-market entry: reconcile fills for ENTRY_RECONCILE_SECONDS
  |      - if direct current-market entry stays imbalanced: defer missing-leg recovery to tracked-current loop
  |      - final current-market fallback near close: optional profitable hedge, else flatten exposure
  |      - if balanced: persist tracked condition ID and keep urgent market cadence
  |
  +--> Optional scheduled tasks:
  |      - redeem task
  |      - telegram task
  |
  `--> sleep until next due task
```

## Phase details

### 1) Startup

- `src/main.ts` loads config and creates logger.
- `src/main.ts` creates `PolymarketBot` and registers SIGINT/SIGTERM handlers.
- `src/bot.ts` initializes CLOB API credentials before entering the loop.
- `src/bot.ts` resolves addresses:
  - signer address from CLOB wallet
  - positions address = `FUNDER` when provided, otherwise signer address
- `src/bot.ts` loads persisted tracked market condition IDs from `STATE_FILE_PATH`.

### 2) Market discovery

- `src/services/marketDiscovery.ts` is used each cycle to find:
  - current active market for current epoch
  - next active market (next epoch first, then current fallback)
- If both are missing, the market task logs a warning and the scheduler retries on the normal market cadence.
- `src/clients/clobWsClient.ts` maintains best bid/ask quote cache from CLOB market websocket.
- Trading reads websocket quotes when fresh (`WS_QUOTES_MAX_AGE_MS`) and falls back to REST order books when stale/unavailable.

### 3) Current tracked market management

This block runs only when the current market condition is already in the tracked set.

- Fetch positions via `src/clients/dataClient.ts` for current condition.
- Summarize with `summarizePositions` and compare with `arePositionsEqual` from `src/services/positionManager.ts`.
- Compute time to close via market discovery service.
- Decision logic:
  - Merge path:
    - conditions: positions are equal, UP size > 0, relayer available, merge not attempted for this condition
    - action: `SettlementService.mergeEqualPositions(...)`
    - note: merge attempts are tracked in-memory by condition (`mergeAttemptedMarkets`) and are not retried again in the same process once attempted
  - Continuous-recovery path:
    - conditions: positions are not equal and time to close is still greater than `FORCE_SELL_THRESHOLD_SECONDS`
    - action: run continuous maker-first missing-leg repricing until balanced, timeout, or force-window transition
  - Force-sell path:
    - conditions: positions are not equal and time to close <= `FORCE_SELL_THRESHOLD_SECONDS`
    - action: evaluate profitable missing-leg hedge first; otherwise cancel open entry orders and flatten

### 4) New entry evaluation

- Candidate entry market is the discovered next market, with current market as fallback when distinct next market is unavailable.
- If next market has the same condition ID as current market, entry is skipped for this cycle.
- Required market metadata checks:
  - token IDs must exist
  - condition ID must exist
- Skip if condition already exists in persisted tracked state.

Exposure guard before placing new paired orders:

- Bot fetches current positions for the candidate condition.
- If any exposure already exists (UP > 0 or DOWN > 0), bot skips entry.
- Additional close-to-expiry cleanup from this guard:
  - if exposure is imbalanced and near close, force-sell is triggered from the entry guard path.

Balance guard before placing new paired orders:

- Required USDC = `ORDER_PRICE * ORDER_SIZE * 2`
- If balance is insufficient, entry is skipped for this cycle.

If all guards pass for a next-market entry:

- Place paired limit BUY orders for UP and DOWN via `TradingEngine.placePairedLimitBuys(...)`.
- Persist condition ID in tracked market state (`STATE_FILE_PATH`) immediately.
- Do not reconcile, reprice, cancel, hedge, or flatten while the market is still next.
- Recovery is deferred until that condition becomes current and is handled by the current-market management loop.

If all guards pass for a direct current-market entry:

- Place paired limit BUY orders for UP and DOWN via `TradingEngine.placePairedLimitBuys(...)`.
- Reconcile fill status via `TradingEngine.reconcilePairedEntry(...)` for `ENTRY_RECONCILE_SECONDS`.
- Missing-leg recovery is not executed in `processEntryMarket`; imbalanced residuals are deferred to `processTrackedCurrentMarket`.
- Near market close (`secondsToClose <= FORCE_SELL_THRESHOLD_SECONDS`), force-window fallback is prioritized.
- Inside force-sell window, if entry is imbalanced:
  - cancel open entry orders first,
  - evaluate missing-leg best ask against profitable hedge threshold:
    - `maxHedgePrice = 1 - filledLegAvgPrice - FORCE_WINDOW_FEE_BUFFER - FORCE_WINDOW_MIN_PROFIT_PER_SHARE`
  - if profitable, complete missing leg and re-check balance,
  - if not profitable (or still imbalanced), flatten filled exposure.
- If balanced within tolerance:
- Persist condition ID in tracked market state (`STATE_FILE_PATH`).
  - Keep urgent market cadence.
- If reconciliation remains imbalanced at timeout:
  - Keep residual exposure and emit imbalance warning/notification.
- Do not persist a new tracked condition for that cycle; recovery is handled later by tracked-current processing.

### 5) Scheduled task error handling and retry behavior

- Each scheduled task is wrapped in `try/catch`.
- Market cadence is centralized via `computeNextMarketInterval()` using task outcomes, tracked exposure, and time-to-close urgency.
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
  - Optional secondary local credentials (`BUILDER_API_KEY_2`, `BUILDER_API_SECRET_2`, `BUILDER_API_PASSPHRASE_2`) can be provided for failover.
  - Remote signer (`BUILDER_SIGNER_URL`, optional `BUILDER_SIGNER_TOKEN`).
- When two local builder credential sets are configured, relayer calls prefer builder1 and fail over to builder2 only on confirmed rate-limit errors; Telegram sends one alert when a failover episode starts.
- Active loop uses merge (`mergeEqualPositions`) when conditions are met.

## State persistence

- Tracked market condition IDs are persisted in `STATE_FILE_PATH`.
- On startup, state is reloaded to avoid duplicate paired entries after restart.

## Notes on behavior differences from older docs

- No hard process stop on low USDC; entry is skipped and loop continues.
- Scheduler cadence is config-driven (`MARKET_POLL_MS`, `MARKET_URGENT_POLL_MS`, `REDEEM_POLL_MS`, `TELEGRAM_POLL_MS`).
- Current implementation uses one scheduler with a market task and optional redeem/telegram tasks.
