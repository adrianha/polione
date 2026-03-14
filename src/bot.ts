import type { Logger } from "pino";
import type {
  BotConfig,
  MarketRecord,
  PositionSummary,
  RedeemStateRecord,
  RedeemTerminalReason,
  RelayerSkippedResult,
  TokenIds,
} from "./types/domain.js";
import { GammaClient } from "./clients/gammaClient.js";
import { PolyClobClient } from "./clients/clobClient.js";
import { ClobWsClient } from "./clients/clobWsClient.js";
import { TelegramClient, escapeHtml, truncateId } from "./clients/telegramClient.js";
import { PolyRelayerClient } from "./clients/relayerClient.js";
import { DataClient } from "./clients/dataClient.js";
import { MarketDiscoveryService } from "./services/marketDiscovery.js";
import { MarketTokenMismatchError, TradingEngine } from "./services/tradingEngine.js";
import { SettlementService } from "./services/settlement.js";
import { RedeemPrecheckService } from "./services/redeemPrecheck.js";
import { arePositionsEqual, summarizePositions } from "./services/positionManager.js";
import { StateStore } from "./utils/stateStore.js";
import { sleep } from "./utils/time.js";

type ConditionLifecycle = "new" | "entry-pending" | "recovery-pending" | "force-window" | "balanced" | "terminal";

export class PolymarketBot {
  private static readonly MERGE_BALANCE_CONFIRMATION_CHECKS = 2;
  private static readonly MIN_MARKET_MAKER_ORDER_SIZE = 5;

  private stopped = false;
  private readonly trackedMarkets = new Set<string>();
  private readonly notifiedPlacementSuccess = new Set<string>();
  private readonly mergeAttemptedMarkets = new Set<string>();
  private readonly redeemStates = new Map<string, RedeemStateRecord>();
  private readonly balancedOrderCleanupDone = new Set<string>();
  private readonly balancedChecksByCondition = new Map<string, number>();
  private readonly recentRecoveryPlacements = new Map<
    string,
    {
      placedAtMs: number;
      summary: PositionSummary;
      missingLegTokenId: string;
      price: number;
      placedSize: number;
      orderId: string | null;
    }
  >();
  private readonly inFlightConditions = new Set<string>();
  private readonly notifiedEntryFilled = new Set<string>();
  private readonly conditionLifecycle = new Map<string, ConditionLifecycle>();
  private relayerFailoverActive = false;

  private readonly gammaClient: GammaClient;
  private readonly clobClient: PolyClobClient;
  private readonly relayerClient: PolyRelayerClient;
  private readonly clobWsClient: ClobWsClient;
  private readonly dataClient: DataClient;
  private readonly marketDiscovery: MarketDiscoveryService;
  private readonly tradingEngine: TradingEngine;
  private readonly settlementService: SettlementService;
  private readonly redeemPrecheckService: RedeemPrecheckService;
  private readonly telegramClient: TelegramClient;
  private readonly stateStore: StateStore;
  private latestCurrentMarket: MarketRecord | null = null;
  private latestNextMarket: MarketRecord | null = null;
  private activeCurrentConditionId: string | null = null;
  private activeCurrentTokenIds: TokenIds | null = null;
  private snapshotUpdatedAtMs: number | null = null;
  private telegramOffset: number | undefined;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {
    this.gammaClient = new GammaClient(config);
    this.clobClient = new PolyClobClient(config);
    this.clobWsClient = new ClobWsClient(config, logger);
    this.relayerClient = new PolyRelayerClient(config);
    this.dataClient = new DataClient(config);
    this.marketDiscovery = new MarketDiscoveryService(config, this.gammaClient);
    this.tradingEngine = new TradingEngine(config, this.clobClient, this.dataClient, this.clobWsClient);
    this.settlementService = new SettlementService(this.relayerClient);
    this.redeemPrecheckService = new RedeemPrecheckService(config);
    this.telegramClient = new TelegramClient({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
      logger,
    });
    this.stateStore = new StateStore(config.stateFilePath);
  }

  private formatTelegramMessage(params: {
    title: string;
    severity: "warn" | "error" | "info";
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    details: Array<{ key: string; value: string | number | null | undefined }>;
  }): string {
    const icon = params.severity === "error" ? "❌" : params.severity === "warn" ? "⚠️" : "✅";
    const lines = [`<b>${icon} ${escapeHtml(params.title)}</b>`];

    if (params.slug) {
      lines.push(`<b>Market</b>: <code>${escapeHtml(params.slug)}</code>`);
    }
    if (params.conditionId) {
      lines.push(`<b>Condition</b>: <code>${escapeHtml(truncateId(params.conditionId))}</code>`);
    }
    if (params.upTokenId || params.downTokenId) {
      lines.push(
        `<b>Tokens</b>: UP <code>${escapeHtml(truncateId(params.upTokenId ?? "-"))}</code> | DOWN <code>${escapeHtml(
          truncateId(params.downTokenId ?? "-"),
        )}</code>`,
      );
    }

    for (const detail of params.details) {
      if (detail.value === null || detail.value === undefined || detail.value === "") {
        continue;
      }
      lines.push(`<b>${escapeHtml(detail.key)}</b>: <code>${escapeHtml(String(detail.value))}</code>`);
    }

    return lines.join("\n");
  }

  private async notify(params: {
    title: string;
    severity: "warn" | "error" | "info";
    dedupeKey: string;
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    details: Array<{ key: string; value: string | number | null | undefined }>;
  }): Promise<void> {
    const message = this.formatTelegramMessage({
      title: params.title,
      severity: params.severity,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.upTokenId,
      downTokenId: params.downTokenId,
      details: params.details,
    });
    await this.telegramClient.sendHtml(message, params.dedupeKey);
  }

  private async notifyOperationalIssue(params: {
    title: string;
    severity: "warn" | "error";
    dedupeKey: string;
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    error?: unknown;
    details?: Array<{ key: string; value: string | number | null | undefined }>;
  }): Promise<void> {
    const details = [...(params.details ?? [])];
    if (params.error !== undefined) {
      details.push({ key: "error", value: this.normalizeError(params.error) });
    }

    await this.notify({
      title: params.title,
      severity: params.severity,
      dedupeKey: params.dedupeKey,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.upTokenId,
      downTokenId: params.downTokenId,
      details,
    });
  }

  private async notifyPlacementSuccessOnce(params: {
    conditionId: string;
    slug?: string;
    upTokenId: string;
    downTokenId: string;
    entryPrice: number;
    orderSize: number;
    attempt: number;
    secondsToClose?: number | null;
    mode: "current-market" | "non-current-market";
  }): Promise<void> {
    if (this.notifiedPlacementSuccess.has(params.conditionId)) {
      return;
    }

    this.notifiedPlacementSuccess.add(params.conditionId);
    await this.notify({
      title: "Paired limit orders placed",
      severity: "info",
      dedupeKey: `placement-success:${params.conditionId}`,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.upTokenId,
      downTokenId: params.downTokenId,
      details: [
        { key: "entryPrice", value: params.entryPrice },
        { key: "orderSize", value: params.orderSize },
        { key: "attempt", value: params.attempt },
        { key: "secondsToClose", value: params.secondsToClose },
        { key: "mode", value: params.mode },
      ],
    });
  }

  private async notifyEntryFilledOnce(params: {
    conditionId: string;
    slug?: string;
    upTokenId: string;
    downTokenId: string;
    upSize: number;
    downSize: number;
    entryPrice?: number;
    filledLegAvgPrice?: number;
    mode: "reconcile" | "continuous-recovery" | "force-window";
  }): Promise<void> {
    if (this.notifiedEntryFilled.has(params.conditionId)) {
      return;
    }

    this.notifiedEntryFilled.add(params.conditionId);
    await this.notify({
      title: "Entry filled and balanced",
      severity: "info",
      dedupeKey: `entry-filled:${params.conditionId}`,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.upTokenId,
      downTokenId: params.downTokenId,
      details: [
        { key: "up", value: params.upSize },
        { key: "down", value: params.downSize },
        { key: "entryPrice", value: params.entryPrice },
        { key: "filledLegAvgPrice", value: params.filledLegAvgPrice },
        { key: "mode", value: params.mode },
      ],
    });
  }

  private async cancelEntryOrdersAfterBalance(
    tokenIds: TokenIds,
    context: { conditionId: string; path: string },
  ): Promise<boolean> {
    try {
      await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
      return true;
    } catch (error) {
      this.logger.warn(
        {
          conditionId: context.conditionId,
          path: context.path,
          error,
        },
        "Failed to cancel residual entry orders after balance",
      );
      await this.notifyOperationalIssue({
        title: "Failed to cancel residual entry orders",
        severity: "warn",
        dedupeKey: `cancel-after-balance-failed:${context.path}:${context.conditionId}`,
        conditionId: context.conditionId,
        upTokenId: tokenIds.upTokenId,
        downTokenId: tokenIds.downTokenId,
        error,
        details: [{ key: "path", value: context.path }],
      });
      return false;
    }
  }

  private getRelayerMeta(result: unknown): { builderLabel?: string; failoverFrom?: string } | null {
    if (!result || typeof result !== "object") {
      return null;
    }

    const meta = (result as Record<string, unknown>).meta;
    if (!meta || typeof meta !== "object") {
      return null;
    }

    const metaObj = meta as Record<string, unknown>;
    return {
      builderLabel: typeof metaObj.builderLabel === "string" ? metaObj.builderLabel : undefined,
      failoverFrom: typeof metaObj.failoverFrom === "string" ? metaObj.failoverFrom : undefined,
    };
  }

  private async maybeNotifyRelayerFailover(params: {
    action: unknown;
    slug?: string;
    conditionId: string;
    upTokenId?: string;
    downTokenId?: string;
  }): Promise<void> {
    const meta = this.getRelayerMeta(params.action);
    if (!meta) {
      return;
    }

    if (meta.builderLabel === "builder1") {
      this.relayerFailoverActive = false;
      return;
    }

    if (!meta.failoverFrom || this.relayerFailoverActive) {
      return;
    }

    this.relayerFailoverActive = true;
    await this.notify({
      title: "Relayer failover activated",
      severity: "warn",
      dedupeKey: `relayer-failover:${meta.failoverFrom}:${meta.builderLabel}`,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.upTokenId,
      downTokenId: params.downTokenId,
      details: [
        { key: "fromBuilder", value: meta.failoverFrom },
        { key: "toBuilder", value: meta.builderLabel },
      ],
    });
  }

  private normalizeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private defaultRedeemState(nowMs: number): RedeemStateRecord {
    return {
      status: "pending",
      attempts: 0,
      nextRetryAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  }

  private getRedeemState(conditionId: string): RedeemStateRecord {
    const existing = this.redeemStates.get(conditionId);
    if (existing) {
      return existing;
    }

    const state = this.defaultRedeemState(Date.now());
    this.redeemStates.set(conditionId, state);
    return state;
  }

  private setRedeemState(conditionId: string, next: RedeemStateRecord): void {
    this.redeemStates.set(conditionId, next);
  }

  private async persistRedeemStates(): Promise<void> {
    try {
      await this.stateStore.saveRedeemStates(this.redeemStates);
    } catch (error) {
      this.logger.error(
        {
          error,
          stateFilePath: this.config.stateFilePath,
        },
        "Failed to persist redeem states",
      );
      await this.notifyOperationalIssue({
        title: "Failed to persist redeem states",
        severity: "error",
        dedupeKey: `persist-redeem-states:${this.config.stateFilePath}`,
        error,
        details: [{ key: "stateFilePath", value: this.config.stateFilePath }],
      });
    }
  }

  private pruneRedeemStates(nowMs: number): number {
    let removed = 0;
    for (const [conditionId, state] of this.redeemStates.entries()) {
      if (state.status !== "terminal") {
        continue;
      }

      const ageMs = nowMs - state.updatedAtMs;
      if (ageMs >= this.config.redeemTerminalStateTtlMs) {
        this.redeemStates.delete(conditionId);
        removed += 1;
      }
    }
    return removed;
  }

  private transitionRedeemState(params: {
    conditionId: string;
    status?: RedeemStateRecord["status"];
    attempts?: number;
    nextRetryAtMs?: number;
    lastError?: string;
    terminalReason?: RedeemTerminalReason;
  }): RedeemStateRecord {
    const previous = this.getRedeemState(params.conditionId);
    const next: RedeemStateRecord = {
      status: params.status ?? previous.status,
      attempts: params.attempts ?? previous.attempts,
      nextRetryAtMs: params.nextRetryAtMs ?? previous.nextRetryAtMs,
      updatedAtMs: Date.now(),
      lastError: params.lastError ?? previous.lastError,
      terminalReason: params.terminalReason ?? previous.terminalReason,
    };
    this.setRedeemState(params.conditionId, next);
    return next;
  }

  private scheduleRedeemRetry(params: {
    conditionId: string;
    reason: string;
    retryAtMs?: number;
    incrementAttempt?: boolean;
  }): RedeemStateRecord {
    const current = this.getRedeemState(params.conditionId);
    const attempts = params.incrementAttempt ? current.attempts + 1 : current.attempts;
    if (attempts >= this.config.redeemMaxRetries) {
      return this.transitionRedeemState({
        conditionId: params.conditionId,
        status: "terminal",
        attempts,
        nextRetryAtMs: Date.now(),
        lastError: params.reason,
        terminalReason: "max_retries_exhausted",
      });
    }

    const retryAtMs = params.retryAtMs ?? Date.now() + Math.max(this.config.redeemRetryBackoffMs, 1000);
    return this.transitionRedeemState({
      conditionId: params.conditionId,
      status: "pending",
      attempts,
      nextRetryAtMs: retryAtMs,
      lastError: params.reason,
    });
  }

  private markRedeemTerminal(
    conditionId: string,
    terminalReason: RedeemTerminalReason,
    lastError?: string,
  ): RedeemStateRecord {
    return this.transitionRedeemState({
      conditionId,
      status: "terminal",
      nextRetryAtMs: Date.now() + (terminalReason === "success" ? this.config.redeemSuccessCooldownMs : 0),
      terminalReason,
      lastError,
    });
  }

  private shouldAttemptRedeem(conditionId: string, nowMs: number): boolean {
    const state = this.getRedeemState(conditionId);
    if (state.status === "terminal") {
      return false;
    }
    if (state.attempts >= this.config.redeemMaxRetries) {
      this.markRedeemTerminal(conditionId, "max_retries_exhausted", state.lastError ?? "Retry budget exhausted");
      return false;
    }
    return nowMs >= state.nextRetryAtMs;
  }

  private isRelayerSkippedResult(value: unknown): value is RelayerSkippedResult {
    return Boolean(
      value &&
      typeof value === "object" &&
      (value as { skipped?: unknown }).skipped === true &&
      typeof (value as { reason?: unknown }).reason === "string",
    );
  }

  private async processRedeemablePositions(positionsAddress: string): Promise<void> {
    if (!this.config.redeemEnabled || !this.relayerClient.isAvailable()) {
      return;
    }

    const nowMs = Date.now();
    const prunedTerminalStates = this.pruneRedeemStates(nowMs);
    let eligibleCount = 0;
    let submittedCount = 0;
    let successCount = 0;
    let skippedRateLimitedCount = 0;
    let terminalNoBalanceCount = 0;
    let terminalNotResolvedCount = 0;
    let failedRetryableCount = 0;
    let failedTerminalCount = 0;
    let skippedByStateCount = 0;

    const positions = await this.dataClient.getPositions(positionsAddress);
    const redeemableConditionIds = Array.from(
      new Set(
        positions
          .filter((position) => position.redeemable === true && typeof position.conditionId === "string")
          .map((position) => position.conditionId)
          .filter((conditionId) => conditionId.length > 0),
      ),
    );

    if (redeemableConditionIds.length === 0) {
      return;
    }

    const candidates = redeemableConditionIds.slice(0, this.config.redeemMaxPerLoop);
    for (const conditionId of candidates) {
      if (!this.shouldAttemptRedeem(conditionId, nowMs)) {
        skippedByStateCount += 1;
        continue;
      }
      eligibleCount += 1;

      const locked = await this.withConditionLock(conditionId, async () => {
        const precheck = await this.redeemPrecheckService.check({
          conditionId,
          positionsAddress: positionsAddress as `0x${string}`,
        });

        if (precheck.status === "not_resolved") {
          terminalNotResolvedCount += 1;
          this.scheduleRedeemRetry({
            conditionId,
            reason: precheck.reason ?? "Condition not resolved yet",
          });
          return;
        }

        if (precheck.status === "no_redeemable_balance") {
          terminalNoBalanceCount += 1;
          this.markRedeemTerminal(conditionId, "already_redeemed", precheck.reason ?? "No redeemable balance");
          return;
        }

        if (precheck.status === "permanent_error") {
          failedTerminalCount += 1;
          this.markRedeemTerminal(conditionId, "permanent_error", precheck.reason ?? "Permanent precheck error");
          return;
        }

        if (precheck.status === "retryable_error") {
          failedRetryableCount += 1;
          this.scheduleRedeemRetry({
            conditionId,
            reason: precheck.reason ?? "Retryable precheck error",
            incrementAttempt: true,
          });
          return;
        }

        this.transitionRedeemState({
          conditionId,
          status: "submitted",
          attempts: this.getRedeemState(conditionId).attempts + 1,
          nextRetryAtMs: Date.now(),
          lastError: undefined,
          terminalReason: undefined,
        });

        try {
          const redeem = await this.settlementService.redeemResolvedPositions(conditionId);
          const relayerMeta = this.getRelayerMeta(redeem);
          await this.maybeNotifyRelayerFailover({ action: redeem, conditionId });

          if (this.isRelayerSkippedResult(redeem) && redeem.reason === "relayer_rate_limited") {
            skippedRateLimitedCount += 1;
            this.scheduleRedeemRetry({
              conditionId,
              reason: redeem.reason,
              retryAtMs: redeem.retryAt ?? Date.now() + this.config.redeemRetryBackoffMs,
            });
            this.logger.warn(
              {
                conditionId,
                retryAt: redeem.retryAt,
              },
              "Redeem skipped: relayer is rate limited",
            );
            return;
          }

          if (!redeem) {
            failedRetryableCount += 1;
            this.scheduleRedeemRetry({
              conditionId,
              reason: "Relayer unavailable or returned null",
              incrementAttempt: true,
            });
            return;
          }

          submittedCount += 1;
          successCount += 1;
          this.markRedeemTerminal(conditionId, "success");
          this.logger.debug(
            {
              redeem,
              conditionId,
              relayerBuilder: relayerMeta?.builderLabel,
              relayerFailoverFrom: relayerMeta?.failoverFrom,
            },
            "Redeem flow executed",
          );
          await this.notify({
            title: "redeemResolvedPositions executed",
            severity: "info",
            dedupeKey: `redeem-success:${conditionId}`,
            conditionId,
            details: [{ key: "builder", value: relayerMeta?.builderLabel }],
          });
        } catch (error) {
          failedRetryableCount += 1;
          const message = this.normalizeError(error);
          const nextState = this.scheduleRedeemRetry({
            conditionId,
            reason: message,
            incrementAttempt: true,
          });
          if (nextState.status === "terminal") {
            failedTerminalCount += 1;
          }

          this.logger.warn(
            {
              conditionId,
              attempts: nextState.attempts,
              nextRetryAtMs: nextState.nextRetryAtMs,
              error,
            },
            "Redeem attempt failed and was scheduled for retry",
          );
        }
      });

      if (!locked.executed) {
        this.logger.debug({ conditionId }, "Redeem loop skipped condition: already in flight");
      }
    }

    await this.persistRedeemStates();
    this.logger.debug(
      {
        candidates: redeemableConditionIds.length,
        cappedCandidates: candidates.length,
        eligible: eligibleCount,
        submitted: submittedCount,
        success: successCount,
        skippedRateLimited: skippedRateLimitedCount,
        terminalNoBalance: terminalNoBalanceCount,
        terminalNotResolved: terminalNotResolvedCount,
        failedRetryable: failedRetryableCount,
        failedTerminal: failedTerminalCount,
        skippedByState: skippedByStateCount,
        prunedTerminalStates,
      },
      "Redeem loop summary",
    );
  }

  private async markTrackedMarket(conditionId: string): Promise<void> {
    this.trackedMarkets.add(conditionId);
    try {
      await this.stateStore.saveTrackedMarkets(this.trackedMarkets);
    } catch (error) {
      this.logger.error(
        {
          error,
          stateFilePath: this.config.stateFilePath,
          conditionId,
        },
        "Failed to persist tracked market state",
      );
      await this.notifyOperationalIssue({
        title: "Failed to persist tracked market",
        severity: "error",
        dedupeKey: `persist-tracked-market:${conditionId}`,
        conditionId,
        error,
        details: [{ key: "stateFilePath", value: this.config.stateFilePath }],
      });
    }
  }

  private transitionConditionLifecycle(conditionId: string, state: ConditionLifecycle): void {
    this.conditionLifecycle.set(conditionId, state);
  }

  stop(): void {
    this.stopped = true;
    this.clobWsClient.stop();
  }

  private getSnapshotAgeMs(): number | null {
    if (this.snapshotUpdatedAtMs === null) {
      return null;
    }
    return Date.now() - this.snapshotUpdatedAtMs;
  }

  private isSnapshotStale(): boolean {
    const ageMs = this.getSnapshotAgeMs();
    if (ageMs === null) {
      return true;
    }

    const maxAgeMs = Math.max(this.config.loopSleepSeconds, 1) * 2000;
    return ageMs > maxAgeMs;
  }

  private async withConditionLock<T>(
    conditionId: string,
    run: () => Promise<T>,
  ): Promise<{ executed: boolean; result?: T }> {
    if (this.inFlightConditions.has(conditionId)) {
      return { executed: false };
    }

    this.inFlightConditions.add(conditionId);
    try {
      const result = await run();
      return { executed: true, result };
    } finally {
      this.inFlightConditions.delete(conditionId);
    }
  }

  private evaluateForceWindowHedge(
    entryPrice: number,
    bestMissingAsk: number,
  ): {
    isProfitable: boolean;
    maxHedgePrice: number;
    expectedLockPnlPerShare: number;
  } {
    const maxHedgePrice = 1 - entryPrice - this.config.forceWindowFeeBuffer - this.config.forceWindowMinProfitPerShare;

    const expectedLockPnlPerShare = 1 - entryPrice - bestMissingAsk - this.config.forceWindowFeeBuffer;

    return {
      isProfitable: expectedLockPnlPerShare >= this.config.forceWindowMinProfitPerShare,
      maxHedgePrice,
      expectedLockPnlPerShare,
    };
  }

  private roundPrice(price: number): number {
    return Number(price.toFixed(4));
  }

  private getImbalancePlan(
    summary: PositionSummary,
    tokenIds: TokenIds,
  ): {
    filledLegTokenId: string;
    missingLegTokenId: string;
    missingAmount: number;
  } | null {
    if (summary.upSize > summary.downSize) {
      const missingAmount = Number((summary.upSize - summary.downSize).toFixed(6));
      if (missingAmount <= 0) {
        return null;
      }
      return {
        filledLegTokenId: tokenIds.upTokenId,
        missingLegTokenId: tokenIds.downTokenId,
        missingAmount,
      };
    }

    if (summary.downSize > summary.upSize) {
      const missingAmount = Number((summary.downSize - summary.upSize).toFixed(6));
      if (missingAmount <= 0) {
        return null;
      }
      return {
        filledLegTokenId: tokenIds.downTokenId,
        missingLegTokenId: tokenIds.upTokenId,
        missingAmount,
      };
    }

    return null;
  }

  private getConditionBuyCapacity(summary: PositionSummary): {
    hasAnyExposure: boolean;
    reachedCap: boolean;
    remainingUp: number;
    remainingDown: number;
  } {
    const cap = Math.max(0, this.config.orderSize);
    const upSize = Math.max(0, summary.upSize);
    const downSize = Math.max(0, summary.downSize);
    const reachedCap =
      cap - upSize <= this.config.positionEqualityTolerance && cap - downSize <= this.config.positionEqualityTolerance;

    return {
      hasAnyExposure: upSize > 0 || downSize > 0,
      reachedCap,
      remainingUp: Number(Math.max(0, cap - upSize).toFixed(6)),
      remainingDown: Number(Math.max(0, cap - downSize).toFixed(6)),
    };
  }

  private hasAnyFill(summary: PositionSummary): boolean {
    return summary.upSize > 0 || summary.downSize > 0;
  }

  private getRemainingAllowanceForTokenId(
    tokenId: string,
    tokenIds: TokenIds,
    buyCapacity: { remainingUp: number; remainingDown: number },
  ): number {
    if (tokenId === tokenIds.upTokenId) {
      return buyCapacity.remainingUp;
    }
    if (tokenId === tokenIds.downTokenId) {
      return buyCapacity.remainingDown;
    }
    return 0;
  }

  private computeMakerMissingLegPrice(params: {
    bestBid: number;
    bestAsk: number;
    maxMissingPrice: number;
    makerOffset?: number;
  }): number {
    const bestBid = Math.max(0, params.bestBid);
    const bestAsk = Math.max(0, params.bestAsk);
    const maxMissingPrice = Math.max(0, params.maxMissingPrice);
    const makerOffset = Math.max(0, params.makerOffset ?? this.config.entryContinuousMakerOffset);
    if (maxMissingPrice <= 0 || bestBid <= 0 || bestAsk <= 0) {
      return 0;
    }

    const makerCandidate = bestBid + makerOffset;
    const nonCrossingCap = Math.max(0, bestAsk - makerOffset);
    const bounded = Math.min(maxMissingPrice, makerCandidate, nonCrossingCap);
    return this.roundPrice(bounded);
  }

  private getTimeAwareRecoveryPolicy(secondsToClose: number | null): {
    progress: number;
    extraProfitBuffer: number;
    makerOffset: number;
    sizeFraction: number;
  } {
    if (secondsToClose === null) {
      return {
        progress: 0,
        extraProfitBuffer: 0,
        makerOffset: this.config.entryContinuousMakerOffset,
        sizeFraction: 1,
      };
    }

    const forceThreshold = this.config.forceSellThresholdSeconds;
    const horizon = Math.max(forceThreshold + 1, this.config.entryRecoveryHorizonSeconds);
    const rawProgress = (secondsToClose - forceThreshold) / (horizon - forceThreshold);
    const progress = Math.min(1, Math.max(0, rawProgress));

    const minSizeFraction = Math.min(1, Math.max(0, this.config.entryRecoveryMinSizeFraction));

    return {
      progress,
      extraProfitBuffer: this.config.entryRecoveryExtraProfitMax * progress,
      makerOffset: this.config.entryContinuousMakerOffset + this.config.entryRecoveryPassiveOffsetMax * progress,
      sizeFraction: 1 - progress * (1 - minSizeFraction),
    };
  }

  private didSummaryChange(previous: PositionSummary, current: PositionSummary): boolean {
    const epsilon = 1e-6;
    return (
      Math.abs(previous.upSize - current.upSize) > epsilon || Math.abs(previous.downSize - current.downSize) > epsilon
    );
  }

  private noteCurrentMarketContext(conditionId: string, tokenIds: TokenIds): void {
    if (this.activeCurrentConditionId === conditionId) {
      this.activeCurrentTokenIds = tokenIds;
      return;
    }

    const previousTokenIds = this.activeCurrentTokenIds;
    const previousConditionId = this.activeCurrentConditionId;
    this.activeCurrentConditionId = conditionId;
    this.activeCurrentTokenIds = tokenIds;

    if (!previousConditionId || !previousTokenIds) {
      return;
    }

    this.recentRecoveryPlacements.delete(previousConditionId);
    this.clobWsClient.clearQuotes([previousTokenIds.upTokenId, previousTokenIds.downTokenId]);
    this.logger.debug(
      {
        previousConditionId,
        nextConditionId: conditionId,
        previousSlug: this.latestCurrentMarket?.slug,
      },
      "Cleared stale recovery and quote cache after current-market transition",
    );
  }

  private async runContinuousMissingLegRecovery(params: {
    market: MarketRecord;
    conditionId: string;
    tokenIds: TokenIds;
    currentSummary: PositionSummary;
    filledLegAvgPrice: number;
    previousPlacement?: {
      placedAtMs: number;
      price: number;
      missingLegTokenId: string;
      summary: PositionSummary;
      placedSize: number;
      orderId: string | null;
    };
  }): Promise<{
    status: "balanced" | "placed" | "unchanged-price" | "timeout" | "force-window" | "not-applicable";
    finalSummary: PositionSummary;
    lastPlacedPrice?: number;
    missingLegTokenId?: string;
    placedSize?: number;
    orderId?: string | null;
    iterations: number;
    reason?: string;
  }> {
    const initialImbalance = this.getImbalancePlan(params.currentSummary, params.tokenIds);
    if (!initialImbalance) {
      return {
        status: "not-applicable",
        finalSummary: params.currentSummary,
        iterations: 0,
        reason: "Initial position is not imbalanced",
      };
    }

    if (!this.config.entryContinuousRepriceEnabled) {
      return {
        status: "timeout",
        finalSummary: params.currentSummary,
        iterations: 0,
        reason: "Continuous repricing disabled",
      };
    }

    const iterations = 1;
    const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(params.market);
    if (secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
      return {
        status: "force-window",
        finalSummary: params.currentSummary,
        iterations,
        reason: "Reached force-sell window during missing-leg recovery",
      };
    }

    const recoveryPolicy = this.getTimeAwareRecoveryPolicy(secondsToClose);
    const latestSummary = params.currentSummary;
    const buyCapacity = this.getConditionBuyCapacity(latestSummary);
    if (buyCapacity.reachedCap) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Strict cap reached; no further buys allowed",
      };
    }

    if (
      latestSummary.upSize > 0 &&
      latestSummary.downSize > 0 &&
      arePositionsEqual(latestSummary, this.config.positionEqualityTolerance)
    ) {
      return {
        status: "balanced",
        finalSummary: latestSummary,
        iterations,
      };
    }

    const imbalance = this.getImbalancePlan(latestSummary, params.tokenIds);
    if (!imbalance) {
      return {
        status: "not-applicable",
        finalSummary: latestSummary,
        iterations,
        reason: "Imbalance no longer present",
      };
    }

    let effectiveMissingAmount = imbalance.missingAmount;
    if (params.previousPlacement && params.previousPlacement.missingLegTokenId === imbalance.missingLegTokenId) {
      const openBuyCoverage = await this.tradingEngine.getOpenBuyExposure(imbalance.missingLegTokenId);
      const snapshotLikelyLagging = !this.didSummaryChange(params.previousPlacement.summary, latestSummary);

      let matchedButNotReflected = 0;
      if (snapshotLikelyLagging && params.previousPlacement.orderId) {
        const fillState = await this.tradingEngine.getOrderFillState(params.previousPlacement.orderId);
        matchedButNotReflected = fillState?.matchedSize ?? 0;
      }

      const pendingCoverage = openBuyCoverage + matchedButNotReflected;
      effectiveMissingAmount = Number(Math.max(0, imbalance.missingAmount - pendingCoverage).toFixed(6));
      if (effectiveMissingAmount <= 1e-6) {
        return {
          status: "unchanged-price",
          finalSummary: latestSummary,
          iterations,
          lastPlacedPrice: params.previousPlacement.price,
          missingLegTokenId: imbalance.missingLegTokenId,
          reason: "Skipped re-order because pending recovery coverage already satisfies missing amount",
        };
      }
    }

    const targetMinProfitPerShare = this.config.forceWindowMinProfitPerShare + recoveryPolicy.extraProfitBuffer;
    const maxMissingPrice = this.roundPrice(
      1 - params.filledLegAvgPrice - this.config.forceWindowFeeBuffer - targetMinProfitPerShare,
    );

    if (maxMissingPrice <= 0) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Missing-leg profitability cap is non-positive",
      };
    }

    let top: { bestBid: number; bestAsk: number };
    try {
      top = await this.tradingEngine.getTopOfBookForCondition({
        conditionId: params.conditionId,
        tokenIds: params.tokenIds,
        tokenId: imbalance.missingLegTokenId,
      });
    } catch (error) {
      if (error instanceof MarketTokenMismatchError) {
        this.logger.warn(
          {
            conditionId: params.conditionId,
            slug: params.market.slug,
            tokenId: imbalance.missingLegTokenId,
            upTokenId: params.tokenIds.upTokenId,
            downTokenId: params.tokenIds.downTokenId,
          },
          "Skipped missing-leg recovery: token is outside current market context",
        );
        await this.notifyOperationalIssue({
          title: "Skipped missing-leg recovery (market mismatch)",
          severity: "warn",
          dedupeKey: `market-token-mismatch:recovery:${params.conditionId}:${imbalance.missingLegTokenId}`,
          slug: params.market.slug,
          conditionId: params.conditionId,
          upTokenId: params.tokenIds.upTokenId,
          downTokenId: params.tokenIds.downTokenId,
          details: [{ key: "tokenId", value: imbalance.missingLegTokenId }],
        });
        return {
          status: "timeout",
          finalSummary: latestSummary,
          iterations,
          reason: "Missing-leg token is not valid for current market condition",
        };
      }
      throw error;
    }
    const makerPrice = this.computeMakerMissingLegPrice({
      bestBid: top.bestBid,
      bestAsk: top.bestAsk,
      maxMissingPrice,
      makerOffset: recoveryPolicy.makerOffset,
    });

    const canCrossBestAsk = top.bestAsk > 0 && top.bestAsk <= maxMissingPrice;
    const nextPrice = canCrossBestAsk ? this.roundPrice(top.bestAsk) : makerPrice;

    if (nextPrice <= 0) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Missing-leg recovery price unavailable",
      };
    }

    if (params.previousPlacement && params.previousPlacement.missingLegTokenId === imbalance.missingLegTokenId) {
      const elapsedMs = Date.now() - params.previousPlacement.placedAtMs;
      const priceDelta = Math.abs(nextPrice - params.previousPlacement.price);
      if (
        elapsedMs < this.config.entryContinuousRepriceIntervalMs &&
        priceDelta < this.config.entryContinuousMinPriceDelta
      ) {
        return {
          status: "unchanged-price",
          finalSummary: latestSummary,
          iterations,
          lastPlacedPrice: params.previousPlacement.price,
          missingLegTokenId: imbalance.missingLegTokenId,
          reason: "Skipped re-order because min reprice interval and min price delta were not met",
        };
      }

      if (priceDelta < 1e-6) {
        return {
          status: "unchanged-price",
          finalSummary: latestSummary,
          iterations,
          lastPlacedPrice: nextPrice,
          missingLegTokenId: imbalance.missingLegTokenId,
          reason: "Skipped re-order because recovery price is unchanged",
        };
      }
    }

    const expectedLockPnlPerShare = 1 - params.filledLegAvgPrice - nextPrice - this.config.forceWindowFeeBuffer;
    if (expectedLockPnlPerShare < targetMinProfitPerShare) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        lastPlacedPrice: nextPrice,
        missingLegTokenId: imbalance.missingLegTokenId,
        reason: "Missing-leg edge below time-aware profitability target",
      };
    }

    const hasSamePriceOpenRecoveryOrder = await this.tradingEngine.hasOpenBuyOrderAtPrice(
      imbalance.missingLegTokenId,
      nextPrice,
    );
    if (hasSamePriceOpenRecoveryOrder) {
      return {
        status: "unchanged-price",
        finalSummary: latestSummary,
        iterations,
        lastPlacedPrice: nextPrice,
        missingLegTokenId: imbalance.missingLegTokenId,
        reason: "Skipped re-order because equivalent open recovery order already exists",
      };
    }

    await this.tradingEngine.cancelEntryOpenOrders(params.tokenIds);
    const remainingForMissingLeg = this.getRemainingAllowanceForTokenId(
      imbalance.missingLegTokenId,
      params.tokenIds,
      buyCapacity,
    );
    if (remainingForMissingLeg <= this.config.positionEqualityTolerance) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Strict cap reached on missing leg; no further buys allowed",
      };
    }

    const cappedMissingAmount = Number(Math.min(effectiveMissingAmount, remainingForMissingLeg).toFixed(6));
    if (cappedMissingAmount < PolymarketBot.MIN_MARKET_MAKER_ORDER_SIZE) {
      this.logger.info(
        {
          conditionId: params.conditionId,
          missingLegTokenId: imbalance.missingLegTokenId,
          effectiveMissingAmount,
          remainingAllowance: remainingForMissingLeg,
          recoveryPolicy,
          cappedMissingAmount,
        },
        "Missing-leg recovery order size below minimum order size; Skipping missing-leg recovery for this cycle.",
      );
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Missing-leg recovery order size below minimum order size after cap clamp",
      };
    }

    const orderResult = await this.tradingEngine.placeSingleLimitBuyAtPrice(
      imbalance.missingLegTokenId,
      nextPrice,
      cappedMissingAmount,
    );
    const orderId = this.tradingEngine.extractOrderId(orderResult);

    return {
      status: "placed",
      finalSummary: latestSummary,
      iterations,
      lastPlacedPrice: nextPrice,
      missingLegTokenId: imbalance.missingLegTokenId,
      placedSize: cappedMissingAmount,
      orderId,
      reason:
        cappedMissingAmount < Number(effectiveMissingAmount.toFixed(6))
          ? `Placed conservative missing-leg recovery order for this cycle (${cappedMissingAmount}/${Number(effectiveMissingAmount.toFixed(6))})`
          : "Placed one missing-leg recovery order for this cycle",
    };
  }

  private async handleForceWindowImbalance(params: {
    market: MarketRecord;
    conditionId: string;
    positionsAddress: string;
    tokenIds: TokenIds;
    summary: PositionSummary;
    secondsToClose: number | null;
    entryPrice: number;
  }): Promise<{ status: "balanced" | "imbalanced" | "failed" }> {
    const { market, conditionId, positionsAddress, tokenIds, summary, secondsToClose, entryPrice } = params;
    const buyCapacity = this.getConditionBuyCapacity(summary);
    const missingLegTokenId = summary.upSize > summary.downSize ? tokenIds.downTokenId : tokenIds.upTokenId;
    const remainingForMissingLeg = this.getRemainingAllowanceForTokenId(missingLegTokenId, tokenIds, buyCapacity);

    if (remainingForMissingLeg <= this.config.positionEqualityTolerance) {
      const cancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
      this.logger.warn(
        {
          conditionId,
          cancelledOpenOrders,
          summary,
          orderSizeCap: this.config.orderSize,
          missingLegTokenId,
          secondsToClose,
        },
        "Inside force-sell window: missing leg reached strict cap, cancelled open orders and left residual imbalance",
      );
      await this.notify({
        title: "Force-window hedge skipped (strict cap reached)",
        severity: "warn",
        dedupeKey: `force-window-cap-reached:${conditionId}`,
        slug: market.slug,
        conditionId,
        upTokenId: tokenIds.upTokenId,
        downTokenId: tokenIds.downTokenId,
        details: [
          { key: "orderSizeCap", value: this.config.orderSize },
          { key: "up", value: summary.upSize },
          { key: "down", value: summary.downSize },
          { key: "diff", value: summary.differenceAbs },
          { key: "secondsToClose", value: secondsToClose },
        ],
      });
      return { status: "imbalanced" };
    }
    let bestMissingAsk = Number.POSITIVE_INFINITY;
    try {
      bestMissingAsk = await this.tradingEngine.getBestAskPriceForCondition({
        conditionId,
        tokenIds,
        tokenId: missingLegTokenId,
      });
    } catch (error) {
      if (error instanceof MarketTokenMismatchError) {
        this.logger.warn(
          {
            conditionId,
            slug: market.slug,
            tokenId: missingLegTokenId,
          },
          "Skipped force-window hedge: missing-leg token is outside current market context",
        );
        await this.notifyOperationalIssue({
          title: "Skipped force-window hedge (market mismatch)",
          severity: "warn",
          dedupeKey: `market-token-mismatch:force-window:${conditionId}:${missingLegTokenId}`,
          slug: market.slug,
          conditionId,
          upTokenId: tokenIds.upTokenId,
          downTokenId: tokenIds.downTokenId,
          details: [{ key: "tokenId", value: missingLegTokenId }],
        });
        return { status: "imbalanced" };
      }
      throw error;
    }

    if (Number.isFinite(bestMissingAsk) && bestMissingAsk > 0) {
      const hedgeCheck = this.evaluateForceWindowHedge(entryPrice, bestMissingAsk);

      if (hedgeCheck.isProfitable) {
        const cancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
        const hedgeBuy = await this.tradingEngine.completeMissingLegForHedge(
          summary,
          tokenIds,
          hedgeCheck.maxHedgePrice,
        );
        const postHedgeReconcile = await this.tradingEngine.reconcilePairedEntry({
          positionsAddress,
          conditionId,
          tokenIds,
          cancelOpenOrders: true,
        });

        if (postHedgeReconcile.status === "balanced") {
          this.logger.info(
            {
              conditionId,
              bestMissingAsk,
              maxHedgePrice: hedgeCheck.maxHedgePrice,
              expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
              cancelledOpenOrders,
              hedgeBuy,
              summary: postHedgeReconcile.finalSummary,
              secondsToClose,
            },
            "Inside force-sell window: completed missing leg and restored balance",
          );
          return { status: "balanced" };
        }

        if (postHedgeReconcile.status === "imbalanced") {
          this.logger.warn(
            {
              conditionId,
              bestMissingAsk,
              maxHedgePrice: hedgeCheck.maxHedgePrice,
              expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
              cancelledOpenOrders,
              hedgeBuy,
              summary: postHedgeReconcile.finalSummary,
              secondsToClose,
            },
            "Inside force-sell window: late hedge remained imbalanced",
          );
          await this.notify({
            title: "Force-window hedge incomplete (residual imbalance)",
            severity: "warn",
            dedupeKey: `post-hedge-residual:${conditionId}`,
            slug: market.slug,
            conditionId,
            upTokenId: tokenIds.upTokenId,
            downTokenId: tokenIds.downTokenId,
            details: [
              { key: "bestMissingAsk", value: bestMissingAsk },
              { key: "maxHedgePrice", value: hedgeCheck.maxHedgePrice },
              { key: "expectedLockPnlPerShare", value: hedgeCheck.expectedLockPnlPerShare },
              { key: "up", value: postHedgeReconcile.finalSummary.upSize },
              { key: "down", value: postHedgeReconcile.finalSummary.downSize },
              { key: "diff", value: postHedgeReconcile.finalSummary.differenceAbs },
              { key: "secondsToClose", value: secondsToClose },
            ],
          });
          return { status: "imbalanced" };
        }

        this.logger.error(
          {
            conditionId,
            bestMissingAsk,
            maxHedgePrice: hedgeCheck.maxHedgePrice,
            expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
            cancelledOpenOrders,
            hedgeBuy,
            reason: postHedgeReconcile.reason,
            summary: postHedgeReconcile.finalSummary,
            secondsToClose,
          },
          "Inside force-sell window: late hedge recovery failed",
        );
        await this.notify({
          title: "Force-window hedge recovery failed",
          severity: "error",
          dedupeKey: `force-window-hedge-failed:${conditionId}`,
          slug: market.slug,
          conditionId,
          upTokenId: tokenIds.upTokenId,
          downTokenId: tokenIds.downTokenId,
          details: [
            { key: "bestMissingAsk", value: bestMissingAsk },
            { key: "maxHedgePrice", value: hedgeCheck.maxHedgePrice },
            { key: "expectedLockPnlPerShare", value: hedgeCheck.expectedLockPnlPerShare },
            { key: "reason", value: postHedgeReconcile.reason },
            { key: "up", value: postHedgeReconcile.finalSummary.upSize },
            { key: "down", value: postHedgeReconcile.finalSummary.downSize },
            { key: "diff", value: postHedgeReconcile.finalSummary.differenceAbs },
            { key: "secondsToClose", value: secondsToClose },
          ],
        });
        return { status: "failed" };
      }

      const cancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
      this.logger.warn(
        {
          conditionId,
          bestMissingAsk,
          maxHedgePrice: hedgeCheck.maxHedgePrice,
          expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
          cancelledOpenOrders,
          summary,
          secondsToClose,
        },
        "Inside force-sell window: hedge not profitable, cancelled open orders and left residual imbalance",
      );
      await this.notify({
        title: "Force-window hedge skipped (not profitable)",
        severity: "warn",
        dedupeKey: `force-window-skip:${conditionId}`,
        slug: market.slug,
        conditionId,
        upTokenId: tokenIds.upTokenId,
        downTokenId: tokenIds.downTokenId,
        details: [
          { key: "bestMissingAsk", value: bestMissingAsk },
          { key: "maxHedgePrice", value: hedgeCheck.maxHedgePrice },
          { key: "expectedLockPnlPerShare", value: hedgeCheck.expectedLockPnlPerShare },
          { key: "up", value: summary.upSize },
          { key: "down", value: summary.downSize },
          { key: "diff", value: summary.differenceAbs },
          { key: "secondsToClose", value: secondsToClose },
        ],
      });
      return { status: "imbalanced" };
    }

    const cancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
    this.logger.warn(
      {
        conditionId,
        bestMissingAsk,
        cancelledOpenOrders,
        summary,
        secondsToClose,
      },
      "Inside force-sell window: missing-leg price unavailable, cancelled open orders and left residual imbalance",
    );
    await this.notify({
      title: "Force-window hedge skipped (missing-leg price unavailable)",
      severity: "warn",
      dedupeKey: `force-window-missing-price:${conditionId}`,
      slug: market.slug,
      conditionId,
      upTokenId: tokenIds.upTokenId,
      downTokenId: tokenIds.downTokenId,
      details: [
        { key: "up", value: summary.upSize },
        { key: "down", value: summary.downSize },
        { key: "diff", value: summary.differenceAbs },
        { key: "secondsToClose", value: secondsToClose },
      ],
    });
    return { status: "imbalanced" };
  }

  private async loadPersistedTrackedMarkets(): Promise<void> {
    try {
      const [loadedMarkets, loadedRedeemStates] = await Promise.all([
        this.stateStore.loadTrackedMarkets(),
        this.stateStore.loadRedeemStates(),
      ]);
      for (const conditionId of loadedMarkets) {
        this.trackedMarkets.add(conditionId);
      }
      for (const [conditionId, state] of loadedRedeemStates.entries()) {
        this.redeemStates.set(conditionId, state);
      }
    } catch (error) {
      this.logger.error(
        {
          error,
          stateFilePath: this.config.stateFilePath,
        },
        "Failed to load persisted bot state",
      );
      await this.notifyOperationalIssue({
        title: "Failed to load persisted bot state",
        severity: "error",
        dedupeKey: `load-bot-state:${this.config.stateFilePath}`,
        error,
        details: [{ key: "stateFilePath", value: this.config.stateFilePath }],
      });
    }
  }

  private async processTrackedCurrentMarket(params: {
    currentMarket: MarketRecord;
    currentConditionId: string;
    positionsAddress: string;
  }): Promise<void> {
    const { currentMarket, currentConditionId, positionsAddress } = params;

    const currentTokenIds = this.marketDiscovery.getTokenIds(currentMarket);
    if (!currentTokenIds) {
      this.logger.warn(
        { slug: currentMarket.slug, conditionId: currentConditionId },
        "Tracked current market missing token IDs",
      );
      await this.notifyOperationalIssue({
        title: "Tracked current market missing token IDs",
        severity: "warn",
        dedupeKey: `tracked-market-missing-token-ids:${currentConditionId}`,
        slug: currentMarket.slug,
        conditionId: currentConditionId,
      });
      return;
    }

    this.noteCurrentMarketContext(currentConditionId, currentTokenIds);

    const currentPositions = await this.dataClient.getPositions(positionsAddress, currentConditionId);
    const currentSummary = summarizePositions(currentPositions, currentTokenIds);
    const positionsEqual = arePositionsEqual(currentSummary, this.config.positionEqualityTolerance);
    const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(currentMarket);
    const nowMs = Date.now();

    const recentPlacement = this.recentRecoveryPlacements.get(currentConditionId);
    if (recentPlacement) {
      const changedSinceLastPlacement = this.didSummaryChange(recentPlacement.summary, currentSummary);
      if (positionsEqual || changedSinceLastPlacement) {
        this.recentRecoveryPlacements.delete(currentConditionId);
      }
    }

    if (!positionsEqual) {
      this.balancedOrderCleanupDone.delete(currentConditionId);
      this.balancedChecksByCondition.delete(currentConditionId);
    } else if (currentSummary.upSize > 0) {
      const confirmations = (this.balancedChecksByCondition.get(currentConditionId) ?? 0) + 1;
      this.balancedChecksByCondition.set(currentConditionId, confirmations);
    }

    this.logger.debug(
      {
        conditionId: currentConditionId,
        slug: currentMarket.slug,
        up: currentSummary.upSize,
        down: currentSummary.downSize,
        diff: currentSummary.differenceAbs,
        equal: positionsEqual,
        secondsToClose,
      },
      "Position check",
    );

    if (positionsEqual && currentSummary.upSize > 0 && !this.balancedOrderCleanupDone.has(currentConditionId)) {
      const cleanupOk = await this.cancelEntryOrdersAfterBalance(currentTokenIds, {
        conditionId: currentConditionId,
        path: "tracked-market:balanced-cleanup",
      });
      if (cleanupOk) {
        this.balancedOrderCleanupDone.add(currentConditionId);
      }
    }

    if (
      positionsEqual &&
      currentSummary.upSize > 0 &&
      this.relayerClient.isAvailable() &&
      !this.mergeAttemptedMarkets.has(currentConditionId)
    ) {
      const balancedChecks = this.balancedChecksByCondition.get(currentConditionId) ?? 0;
      if (balancedChecks < PolymarketBot.MERGE_BALANCE_CONFIRMATION_CHECKS) {
        this.logger.info(
          {
            conditionId: currentConditionId,
            slug: currentMarket.slug,
            balancedChecks,
            requiredChecks: PolymarketBot.MERGE_BALANCE_CONFIRMATION_CHECKS,
            secondsToClose,
          },
          "Delaying merge until balance is stable across consecutive checks",
        );
        return;
      }

      const amount = Math.min(currentSummary.upSize, currentSummary.downSize);
      const merge = await this.settlementService.mergeEqualPositions(currentConditionId, amount);
      const mergeObj = merge && typeof merge === "object" ? (merge as unknown as Record<string, unknown>) : null;
      const isRateLimitedSkip = mergeObj?.skipped === true && mergeObj?.reason === "relayer_rate_limited";

      if (isRateLimitedSkip) {
        this.logger.warn(
          {
            conditionId: currentConditionId,
            retryAt: mergeObj?.retryAt,
          },
          "Merge skipped: relayer is rate limited",
        );
        await this.notify({
          title: "Merge skipped (relayer rate limited)",
          severity: "warn",
          dedupeKey: `merge-rate-limit:${currentConditionId}`,
          slug: currentMarket.slug,
          conditionId: currentConditionId,
          upTokenId: currentTokenIds.upTokenId,
          downTokenId: currentTokenIds.downTokenId,
          details: [
            { key: "retryAt", value: mergeObj?.retryAt as string | number | undefined },
            { key: "secondsToClose", value: secondsToClose },
          ],
        });
        return;
      }

      const relayerMeta = this.getRelayerMeta(merge);
      await this.maybeNotifyRelayerFailover({
        action: merge,
        slug: currentMarket.slug,
        conditionId: currentConditionId,
        upTokenId: currentTokenIds.upTokenId,
        downTokenId: currentTokenIds.downTokenId,
      });

      this.mergeAttemptedMarkets.add(currentConditionId);
      this.logger.info(
        {
          merge,
          conditionId: currentConditionId,
          relayerBuilder: relayerMeta?.builderLabel,
          relayerFailoverFrom: relayerMeta?.failoverFrom,
        },
        "Merge flow executed",
      );
      await this.notify({
        title: "mergeEqualPositions executed",
        severity: "info",
        dedupeKey: `merge-success:${currentConditionId}`,
        slug: currentMarket.slug,
        conditionId: currentConditionId,
        upTokenId: currentTokenIds.upTokenId,
        downTokenId: currentTokenIds.downTokenId,
        details: [
          { key: "amount", value: amount },
          { key: "secondsToClose", value: secondsToClose },
          { key: "builder", value: relayerMeta?.builderLabel },
        ],
      });
      return;
    }

    if (!positionsEqual && secondsToClose !== null && secondsToClose > this.config.forceSellThresholdSeconds) {
      this.transitionConditionLifecycle(currentConditionId, "recovery-pending");
      const placementLock = this.recentRecoveryPlacements.get(currentConditionId);

      const recovery = await this.runContinuousMissingLegRecovery({
        market: currentMarket,
        conditionId: currentConditionId,
        tokenIds: currentTokenIds,
        currentSummary,
        filledLegAvgPrice: this.config.orderPrice,
        previousPlacement: placementLock
          ? {
              placedAtMs: placementLock.placedAtMs,
              price: placementLock.price,
              missingLegTokenId: placementLock.missingLegTokenId,
              summary: placementLock.summary,
              placedSize: placementLock.placedSize,
              orderId: placementLock.orderId,
            }
          : undefined,
      });

      if (recovery.status === "balanced") {
        this.recentRecoveryPlacements.delete(currentConditionId);
        await this.cancelEntryOrdersAfterBalance(currentTokenIds, {
          conditionId: currentConditionId,
          path: "tracked-market:continuous-recovery",
        });
        await this.notifyEntryFilledOnce({
          conditionId: currentConditionId,
          slug: currentMarket.slug,
          upTokenId: currentTokenIds.upTokenId,
          downTokenId: currentTokenIds.downTokenId,
          upSize: recovery.finalSummary.upSize,
          downSize: recovery.finalSummary.downSize,
          entryPrice: this.config.orderPrice,
          filledLegAvgPrice: this.config.orderPrice,
          mode: "continuous-recovery",
        });
        this.logger.info(
          {
            conditionId: currentConditionId,
            slug: currentMarket.slug,
            summary: recovery.finalSummary,
            iterations: recovery.iterations,
            lastPlacedPrice: recovery.lastPlacedPrice,
            secondsToClose,
          },
          "Recovered imbalanced current market outside force-sell window",
        );
        return;
      }

      if (recovery.status === "force-window") {
        this.transitionConditionLifecycle(currentConditionId, "force-window");
        this.recentRecoveryPlacements.delete(currentConditionId);
        const forceRecovery = await this.handleForceWindowImbalance({
          market: currentMarket,
          conditionId: currentConditionId,
          positionsAddress,
          tokenIds: currentTokenIds,
          summary: recovery.finalSummary,
          secondsToClose,
          entryPrice: this.config.orderPrice,
        });

        if (forceRecovery.status === "balanced") {
          this.transitionConditionLifecycle(currentConditionId, "balanced");
          await this.cancelEntryOrdersAfterBalance(currentTokenIds, {
            conditionId: currentConditionId,
            path: "tracked-market:force-window",
          });
          await this.notifyEntryFilledOnce({
            conditionId: currentConditionId,
            slug: currentMarket.slug,
            upTokenId: currentTokenIds.upTokenId,
            downTokenId: currentTokenIds.downTokenId,
            upSize: recovery.finalSummary.upSize,
            downSize: recovery.finalSummary.downSize,
            entryPrice: this.config.orderPrice,
            filledLegAvgPrice: this.config.orderPrice,
            mode: "force-window",
          });
        }
        return;
      }

      if (recovery.status === "placed") {
        this.transitionConditionLifecycle(currentConditionId, "recovery-pending");
        if (recovery.lastPlacedPrice !== undefined && recovery.missingLegTokenId) {
          this.recentRecoveryPlacements.set(currentConditionId, {
            placedAtMs: nowMs,
            summary: recovery.finalSummary,
            missingLegTokenId: recovery.missingLegTokenId,
            price: recovery.lastPlacedPrice,
            placedSize: recovery.placedSize ?? 0,
            orderId: recovery.orderId ?? null,
          });
        }
        this.logger.info(
          {
            conditionId: currentConditionId,
            slug: currentMarket.slug,
            summary: recovery.finalSummary,
            iterations: recovery.iterations,
            lastPlacedPrice: recovery.lastPlacedPrice,
            reason: recovery.reason,
            secondsToClose,
          },
          "Placed one missing-leg recovery order for tracked current market",
        );
        return;
      }

      if (recovery.status === "unchanged-price") {
        return;
      }

      this.logger.warn(
        {
          conditionId: currentConditionId,
          slug: currentMarket.slug,
          summary: recovery.finalSummary,
          status: recovery.status,
          reason: recovery.reason,
          iterations: recovery.iterations,
          secondsToClose,
        },
        "Continuous recovery could not rebalance current market outside force-sell window",
      );
      return;
    }

    if (!positionsEqual && secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
      this.transitionConditionLifecycle(currentConditionId, "force-window");
      const recovery = await this.handleForceWindowImbalance({
        market: currentMarket,
        conditionId: currentConditionId,
        positionsAddress,
        tokenIds: currentTokenIds,
        summary: currentSummary,
        secondsToClose,
        entryPrice: this.config.orderPrice,
      });

      if (recovery.status !== "balanced") {
        return;
      }

      await this.cancelEntryOrdersAfterBalance(currentTokenIds, {
        conditionId: currentConditionId,
        path: "tracked-market:force-window-existing",
      });

      this.transitionConditionLifecycle(currentConditionId, "balanced");

      this.logger.info(
        { conditionId: currentConditionId, secondsToClose, summary: currentSummary },
        "Recovered imbalanced current market inside force-sell window",
      );
    }
  }

  private selectEntryMarket(params: {
    currentMarket: MarketRecord | null;
    nextMarket: MarketRecord | null;
    currentConditionId: string | null;
  }): MarketRecord | null {
    const { currentMarket, nextMarket, currentConditionId } = params;

    if (nextMarket) {
      const nextConditionId = this.marketDiscovery.getConditionId(nextMarket);
      if (!currentConditionId || nextConditionId !== currentConditionId) {
        return nextMarket;
      }
    }

    return currentMarket;
  }

  private async processEntryMarket(params: {
    entryMarket: MarketRecord;
    currentConditionId: string | null;
    positionsAddress: string;
  }): Promise<number> {
    const { entryMarket, currentConditionId, positionsAddress } = params;

    const entryTokenIds = this.marketDiscovery.getTokenIds(entryMarket);
    if (!entryTokenIds) {
      this.logger.warn({ slug: entryMarket.slug }, "Entry market found but no token IDs");
      await this.notifyOperationalIssue({
        title: "Entry market missing token IDs",
        severity: "warn",
        dedupeKey: `entry-market-missing-token-ids:${entryMarket.slug}`,
        slug: entryMarket.slug,
      });
      return this.config.loopSleepSeconds;
    }

    this.clobWsClient.ensureSubscribed([entryTokenIds.upTokenId, entryTokenIds.downTokenId]);

    const entryConditionId = this.marketDiscovery.getConditionId(entryMarket);
    if (!entryConditionId) {
      this.logger.warn({ slug: entryMarket.slug }, "Entry market missing condition ID");
      await this.notifyOperationalIssue({
        title: "Entry market missing condition ID",
        severity: "warn",
        dedupeKey: `entry-market-missing-condition-id:${entryMarket.slug}`,
        slug: entryMarket.slug,
      });
      return this.config.loopSleepSeconds;
    }

    this.logger.debug(
      {
        slug: entryMarket.slug,
        conditionId: entryConditionId,
        upTokenId: entryTokenIds.upTokenId,
        downTokenId: entryTokenIds.downTokenId,
      },
      "Evaluating entry market",
    );

    const existingPositions = await this.dataClient.getPositions(positionsAddress, entryConditionId);
    const existingSummary = summarizePositions(existingPositions, entryTokenIds);
    const buyCapacity = this.getConditionBuyCapacity(existingSummary);
    if (buyCapacity.hasAnyExposure) {
      this.logger.warn(
        {
          conditionId: entryConditionId,
          slug: entryMarket.slug,
          up: existingSummary.upSize,
          down: existingSummary.downSize,
          diff: existingSummary.differenceAbs,
          orderSizeCap: this.config.orderSize,
          reachedCap: buyCapacity.reachedCap,
          remainingUp: buyCapacity.remainingUp,
          remainingDown: buyCapacity.remainingDown,
        },
        "Skipped paired entry: existing exposure detected; handed off to tracked-market recovery",
      );
      await this.markTrackedMarket(entryConditionId);
      this.transitionConditionLifecycle(entryConditionId, "recovery-pending");
      return this.config.loopSleepSeconds;
    }

    if (this.trackedMarkets.has(entryConditionId)) {
      this.logger.debug(
        {
          conditionId: entryConditionId,
          slug: entryMarket.slug,
        },
        "Skipped new entry: market already tracked",
      );
      return this.config.loopSleepSeconds;
    }

    const requiredUsdcForBothLegs = this.config.orderPrice * this.config.orderSize * 2;
    const currentUsdcBalance = await this.clobClient.getUsdcBalance();
    if (currentUsdcBalance < requiredUsdcForBothLegs) {
      this.logger.debug(
        {
          conditionId: entryConditionId,
          slug: entryMarket.slug,
          usdcBalance: currentUsdcBalance,
          requiredUsdc: requiredUsdcForBothLegs,
        },
        "Skipped new entry: insufficient USDC balance for both legs",
      );
      return this.config.loopSleepSeconds;
    }

    const isCurrentMarketEntry = currentConditionId !== null && entryConditionId === currentConditionId;
    const secondsToClose = isCurrentMarketEntry ? this.marketDiscovery.getSecondsToMarketClose(entryMarket) : null;
    const isInsideForceSellWindow =
      isCurrentMarketEntry && secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds;

    if (!isCurrentMarketEntry) {
      this.transitionConditionLifecycle(entryConditionId, "entry-pending");
      const entryPrice = this.config.orderPrice;
      const paired = await this.tradingEngine.placePairedLimitBuysAtPrice(
        entryTokenIds,
        entryPrice,
        this.config.orderSize,
      );
      this.logger.info(
        {
          paired,
          conditionId: entryConditionId,
          entryPrice,
          orderSize: this.config.orderSize,
        },
        "Placed paired limit buy orders for non-current market; liquidity gate bypassed",
      );
      await this.notifyPlacementSuccessOnce({
        conditionId: entryConditionId,
        slug: entryMarket.slug,
        upTokenId: entryTokenIds.upTokenId,
        downTokenId: entryTokenIds.downTokenId,
        entryPrice,
        orderSize: this.config.orderSize,
        attempt: 0,
        mode: "non-current-market",
      });
      await this.markTrackedMarket(entryConditionId);
      this.transitionConditionLifecycle(entryConditionId, "entry-pending");
      this.logger.info(
        {
          conditionId: entryConditionId,
          slug: entryMarket.slug,
        },
        "Deferred recovery for non-current market until it becomes current",
      );
      return this.config.loopSleepSeconds;
    }

    const entryPrice = this.config.orderPrice;
    this.transitionConditionLifecycle(entryConditionId, isInsideForceSellWindow ? "force-window" : "entry-pending");

    const paired = await this.tradingEngine.placePairedLimitBuysAtPrice(
      entryTokenIds,
      entryPrice,
      this.config.orderSize,
    );
    this.logger.info(
      {
        paired,
        conditionId: entryConditionId,
        entryPrice,
        orderSize: this.config.orderSize,
        secondsToClose,
        forceSellWindow: isInsideForceSellWindow,
      },
      "Placed paired limit buy orders",
    );
    await this.notifyPlacementSuccessOnce({
      conditionId: entryConditionId,
      slug: entryMarket.slug,
      upTokenId: entryTokenIds.upTokenId,
      downTokenId: entryTokenIds.downTokenId,
      entryPrice,
      orderSize: this.config.orderSize,
      attempt: 0,
      secondsToClose,
      mode: "current-market",
    });

    const reconcile = await this.tradingEngine.reconcilePairedEntry({
      positionsAddress,
      conditionId: entryConditionId,
      tokenIds: entryTokenIds,
      cancelOpenOrders: !isInsideForceSellWindow,
    });

    if (isInsideForceSellWindow && reconcile.status === "imbalanced") {
      const recovery = await this.handleForceWindowImbalance({
        market: entryMarket,
        conditionId: entryConditionId,
        positionsAddress,
        tokenIds: entryTokenIds,
        summary: reconcile.finalSummary,
        secondsToClose,
        entryPrice,
      });

      if (recovery.status === "balanced") {
        await this.cancelEntryOrdersAfterBalance(entryTokenIds, {
          conditionId: entryConditionId,
          path: "entry-market:force-window",
        });
        await this.markTrackedMarket(entryConditionId);
        return this.config.positionRecheckSeconds;
      }

      return this.config.loopSleepSeconds;
    }

    if (reconcile.status === "balanced") {
      await this.cancelEntryOrdersAfterBalance(entryTokenIds, {
        conditionId: entryConditionId,
        path: "entry-market:reconcile",
      });
      await this.notifyEntryFilledOnce({
        conditionId: entryConditionId,
        slug: entryMarket.slug,
        upTokenId: entryTokenIds.upTokenId,
        downTokenId: entryTokenIds.downTokenId,
        upSize: reconcile.finalSummary.upSize,
        downSize: reconcile.finalSummary.downSize,
        entryPrice,
        mode: "reconcile",
      });
      await this.markTrackedMarket(entryConditionId);
      this.transitionConditionLifecycle(entryConditionId, "balanced");
      this.logger.info(
        {
          conditionId: entryConditionId,
          status: reconcile.status,
          attempts: reconcile.attempts,
          summary: reconcile.finalSummary,
          entryPrice,
        },
        "Entry reconciliation succeeded",
      );
      return this.config.positionRecheckSeconds;
    }

    if (reconcile.status === "imbalanced") {
      let handoffCancelledOpenOrders: unknown[] | undefined;
      try {
        handoffCancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(entryTokenIds);
      } catch (error) {
        this.logger.warn(
          {
            conditionId: entryConditionId,
            error,
            path: "entry-market:imbalance-handoff-cancel",
          },
          "Failed to immediately cancel paired entry orders during recovery handoff",
        );
      }

      await this.markTrackedMarket(entryConditionId);
      this.transitionConditionLifecycle(
        entryConditionId,
        isInsideForceSellWindow ? "force-window" : "recovery-pending",
      );
      this.logger.warn(
        {
          conditionId: entryConditionId,
          status: reconcile.status,
          attempts: reconcile.attempts,
          summary: reconcile.finalSummary,
          cancelledOpenOrders: reconcile.cancelledOpenOrders,
          reason: reconcile.reason,
          entryPrice,
          secondsToClose,
          forceSellWindow: isInsideForceSellWindow,
          handoff: "tracked-market-recovery",
          handoffCancelledOpenOrders,
        },
        "Entry reconciliation detected partial fill; cancelled paired orders and handed off to tracked-market recovery",
      );
      await this.notify({
        title: "Entry remains imbalanced",
        severity: "warn",
        dedupeKey: `reconcile-imbalanced:${entryConditionId}`,
        slug: entryMarket.slug,
        conditionId: entryConditionId,
        upTokenId: entryTokenIds.upTokenId,
        downTokenId: entryTokenIds.downTokenId,
        details: [
          { key: "attempt", value: 0 },
          { key: "entryPrice", value: entryPrice },
          { key: "up", value: reconcile.finalSummary.upSize },
          { key: "down", value: reconcile.finalSummary.downSize },
          { key: "diff", value: reconcile.finalSummary.differenceAbs },
          { key: "reason", value: reconcile.reason },
          { key: "secondsToClose", value: secondsToClose },
        ],
      });
      return this.config.loopSleepSeconds;
    }

    this.transitionConditionLifecycle(entryConditionId, "terminal");
    this.logger.error(
      {
        conditionId: entryConditionId,
        status: reconcile.status,
        attempts: reconcile.attempts,
        summary: reconcile.finalSummary,
        cancelledOpenOrders: reconcile.cancelledOpenOrders,
        reason: reconcile.reason,
        entryPrice,
      },
      "Entry reconciliation failed",
    );
    await this.notify({
      title: "Entry reconciliation failed",
      severity: "error",
      dedupeKey: `reconcile-failed:${entryConditionId}`,
      slug: entryMarket.slug,
      conditionId: entryConditionId,
      upTokenId: entryTokenIds.upTokenId,
      downTokenId: entryTokenIds.downTokenId,
      details: [
        { key: "attempt", value: 0 },
        { key: "entryPrice", value: entryPrice },
        { key: "up", value: reconcile.finalSummary.upSize },
        { key: "down", value: reconcile.finalSummary.downSize },
        { key: "diff", value: reconcile.finalSummary.differenceAbs },
        { key: "reason", value: reconcile.reason },
        { key: "secondsToClose", value: secondsToClose },
      ],
    });

    return this.config.loopSleepSeconds;
  }

  private async updateMarketSnapshot(): Promise<void> {
    const [currentMarket, nextMarket] = await Promise.all([
      this.marketDiscovery.findCurrentActiveMarket(),
      this.marketDiscovery.findNextActiveMarket(),
    ]);

    this.latestCurrentMarket = currentMarket;
    this.latestNextMarket = nextMarket;
    this.snapshotUpdatedAtMs = Date.now();

    if (!currentMarket && !nextMarket) {
      this.logger.warn("No active market found, retrying");
      await this.notifyOperationalIssue({
        title: "No active market found",
        severity: "warn",
        dedupeKey: "no-active-market",
      });
    }
  }

  private async discoveryLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.updateMarketSnapshot();
      } catch (error) {
        this.logger.error({ error }, "Discovery loop error");
        await this.notifyOperationalIssue({
          title: "Discovery loop error",
          severity: "error",
          dedupeKey: "loop-error:discovery",
          error,
        });
      }

      await sleep(this.config.loopSleepSeconds);
    }
  }

  private async currentMarketLoop(positionsAddress: string): Promise<void> {
    while (!this.stopped) {
      try {
        if (this.isSnapshotStale()) {
          this.logger.warn(
            { snapshotAgeMs: this.getSnapshotAgeMs() },
            "Current market loop skipped: stale market snapshot",
          );
          await sleep(this.config.currentLoopSleepSeconds);
          continue;
        }

        const currentMarket = this.latestCurrentMarket;
        if (!currentMarket) {
          await sleep(this.config.currentLoopSleepSeconds);
          continue;
        }

        const currentConditionId = this.marketDiscovery.getConditionId(currentMarket);
        if (currentConditionId && this.trackedMarkets.has(currentConditionId)) {
          const locked = await this.withConditionLock(currentConditionId, async () => {
            await this.processTrackedCurrentMarket({
              currentMarket,
              currentConditionId,
              positionsAddress,
            });
          });

          if (!locked.executed) {
            this.logger.debug(
              { conditionId: currentConditionId },
              "Current market loop skipped: condition already in flight",
            );
          }
        }
      } catch (error) {
        this.logger.error({ error }, "Current market loop error");
        await this.notifyOperationalIssue({
          title: "Current market loop error",
          severity: "error",
          dedupeKey: "loop-error:current-market",
          error,
        });
      }

      await sleep(this.config.currentLoopSleepSeconds);
    }
  }

  private async telegramCommandLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.telegramClient.isEnabled()) {
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const updates = await this.telegramClient.getUpdates(this.telegramOffset);
        for (const update of updates) {
          this.telegramOffset = update.update_id + 1;

          const text = update.message?.text?.trim().toLowerCase();
          const chatId = update.message?.chat?.id;
          if (!text || typeof chatId !== "number") {
            continue;
          }

          if (this.config.telegramChatId && String(chatId) !== this.config.telegramChatId) {
            continue;
          }

          if (text === "/balance" || text === "/usdc" || text === "balance") {
            try {
              const balance = await this.clobClient.getUsdcBalance();
              await this.notify({
                title: "USDC balance",
                severity: "info",
                dedupeKey: `telegram-balance:${Math.floor(Date.now() / 5000)}`,
                details: [
                  { key: "usdc", value: balance },
                  { key: "mode", value: this.config.dryRun ? "SAFE (DRY_RUN)" : "LIVE" },
                ],
              });
            } catch (error) {
              await this.notify({
                title: "USDC balance check failed",
                severity: "error",
                dedupeKey: `telegram-balance-error:${Math.floor(Date.now() / 5000)}`,
                details: [{ key: "error", value: error instanceof Error ? error.message : String(error) }],
              });
            }
          }
        }
      } catch (error) {
        this.logger.warn({ error }, "Telegram command loop error");
        await this.notifyOperationalIssue({
          title: "Telegram command loop error",
          severity: "warn",
          dedupeKey: "loop-error:telegram-command",
          error,
        });
      }

      await sleep(Math.max(2, this.config.loopSleepSeconds));
    }
  }

  private async entryLoop(positionsAddress: string): Promise<void> {
    while (!this.stopped) {
      let sleepSeconds = this.config.loopSleepSeconds;

      try {
        if (this.isSnapshotStale()) {
          this.logger.warn({ snapshotAgeMs: this.getSnapshotAgeMs() }, "Entry loop skipped: stale market snapshot");
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const currentMarket = this.latestCurrentMarket;
        const nextMarket = this.latestNextMarket;

        if (!currentMarket && !nextMarket) {
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const currentConditionId = currentMarket ? this.marketDiscovery.getConditionId(currentMarket) : null;
        const entryMarket = this.selectEntryMarket({
          currentMarket,
          nextMarket,
          currentConditionId,
        });

        if (!entryMarket) {
          this.logger.info("No market available for new entry");
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const entryConditionId = this.marketDiscovery.getConditionId(entryMarket);
        if (!entryConditionId) {
          sleepSeconds = await this.processEntryMarket({
            entryMarket,
            currentConditionId,
            positionsAddress,
          });
        } else {
          const locked = await this.withConditionLock(entryConditionId, async () => {
            return this.processEntryMarket({
              entryMarket,
              currentConditionId,
              positionsAddress,
            });
          });

          if (!locked.executed) {
            this.logger.debug({ conditionId: entryConditionId }, "Entry loop skipped: condition already in flight");
            sleepSeconds = this.config.loopSleepSeconds;
          } else {
            sleepSeconds = locked.result ?? this.config.loopSleepSeconds;
          }
        }
      } catch (error) {
        this.logger.error({ error }, "Entry loop error");
        await this.notifyOperationalIssue({
          title: "Entry loop error",
          severity: "error",
          dedupeKey: "loop-error:entry",
          error,
        });
      }

      await sleep(sleepSeconds);
    }
  }

  private async redeemLoop(positionsAddress: string): Promise<void> {
    while (!this.stopped) {
      try {
        await this.processRedeemablePositions(positionsAddress);
      } catch (error) {
        this.logger.error({ error }, "Redeem loop error");
        await this.notifyOperationalIssue({
          title: "Redeem loop error",
          severity: "error",
          dedupeKey: "loop-error:redeem",
          error,
        });
      }

      await sleep(this.config.redeemLoopSleepSeconds);
    }
  }

  async runForever(): Promise<void> {
    await this.clobClient.init();
    this.clobWsClient.start();
    const userAddress = this.clobClient.getSignerAddress();
    const positionsAddress = this.config.funder ?? userAddress;

    await this.loadPersistedTrackedMarkets();

    this.logger.info(
      {
        dryRun: this.config.dryRun,
        userAddress,
        positionsAddress,
        relayerEnabled: this.relayerClient.isAvailable(),
        availableRelayerBuilders: this.relayerClient.getAvailableBuilderLabels(),
        persistedTrackedMarketCount: this.trackedMarkets.size,
        persistedRedeemStateCount: this.redeemStates.size,
        stateFilePath: this.config.stateFilePath,
      },
      "Bot initialized",
    );

    await this.notify({
      title: "Bot started",
      severity: "info",
      dedupeKey: `bot-start:${Math.floor(Date.now() / 60000)}`,
      details: [
        { key: "mode", value: this.config.dryRun ? "SAFE (DRY_RUN)" : "LIVE" },
        { key: "chainId", value: this.config.chainId },
        { key: "userAddress", value: userAddress },
        { key: "positionsAddress", value: positionsAddress },
        { key: "marketPrefix", value: this.config.marketSlugPrefix },
        { key: "orderPrice", value: this.config.orderPrice },
        { key: "orderSize", value: this.config.orderSize },
        { key: "forceSellThresholdSec", value: this.config.forceSellThresholdSeconds },
        { key: "loopSleepSec", value: this.config.loopSleepSeconds },
        { key: "currentLoopSleepSec", value: this.config.currentLoopSleepSeconds },
        { key: "positionRecheckSec", value: this.config.positionRecheckSeconds },
        { key: "entryReconcileSec", value: this.config.entryReconcileSeconds },
        { key: "redeemEnabled", value: this.config.redeemEnabled ? "true" : "false" },
        { key: "redeemLoopSleepSec", value: this.config.redeemLoopSleepSeconds },
        { key: "redeemMaxRetries", value: this.config.redeemMaxRetries },
        { key: "wsEnabled", value: this.config.enableClobWs ? "true" : "false" },
        { key: "relayerEnabled", value: this.relayerClient.isAvailable() ? "true" : "false" },
        { key: "availableBuilders", value: this.relayerClient.getAvailableBuilderLabels().join(", ") || "none" },
      ],
    });

    await this.updateMarketSnapshot();
    await Promise.all([
      this.discoveryLoop(),
      this.currentMarketLoop(positionsAddress),
      this.entryLoop(positionsAddress),
      this.redeemLoop(positionsAddress),
      this.telegramCommandLoop(),
    ]);

    await this.notify({
      title: "Bot stopped",
      severity: "warn",
      dedupeKey: `bot-stop:${Math.floor(Date.now() / 60000)}`,
      details: [
        { key: "mode", value: this.config.dryRun ? "SAFE (DRY_RUN)" : "LIVE" },
        { key: "trackedMarketCount", value: this.trackedMarkets.size },
        { key: "stateFilePath", value: this.config.stateFilePath },
      ],
    });

    this.logger.info("Bot stopped");
  }
}
