import type { Logger } from "pino";
import type { BotConfig, MarketRecord, PositionSummary, TokenIds } from "./types/domain.js";
import { GammaClient } from "./clients/gammaClient.js";
import { PolyClobClient } from "./clients/clobClient.js";
import { ClobWsClient } from "./clients/clobWsClient.js";
import { TelegramClient, escapeHtml, truncateId } from "./clients/telegramClient.js";
import { PolyRelayerClient } from "./clients/relayerClient.js";
import { DataClient } from "./clients/dataClient.js";
import { MarketDiscoveryService } from "./services/marketDiscovery.js";
import { TradingEngine } from "./services/tradingEngine.js";
import { SettlementService } from "./services/settlement.js";
import { arePositionsEqual, summarizePositions } from "./services/positionManager.js";
import { StateStore } from "./utils/stateStore.js";
import { sleep } from "./utils/time.js";

type ConditionLifecycle =
  | "new"
  | "entry-pending"
  | "recovery-pending"
  | "force-window"
  | "balanced"
  | "terminal";

export class PolymarketBot {
  private static readonly RECOVERY_REARM_COOLDOWN_MS = 15_000;
  private static readonly MERGE_BALANCE_CONFIRMATION_CHECKS = 2;
  private static readonly REDEEM_RETRY_BACKOFF_MS = 60_000;
  private static readonly REDEEM_SUCCESS_COOLDOWN_MS = 5 * 60_000;

  private stopped = false;
  private readonly trackedMarkets = new Set<string>();
  private readonly notifiedPlacementSuccess = new Set<string>();
  private readonly mergeAttemptedMarkets = new Set<string>();
  private readonly redeemNextAttemptAtByCondition = new Map<string, number>();
  private readonly balancedOrderCleanupDone = new Set<string>();
  private readonly balancedChecksByCondition = new Map<string, number>();
  private readonly recentRecoveryPlacements = new Map<
    string,
    {
      placedAtMs: number;
      summary: PositionSummary;
      missingLegTokenId: string;
      price: number;
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
  private readonly telegramClient: TelegramClient;
  private readonly stateStore: StateStore;
  private latestCurrentMarket: MarketRecord | null = null;
  private latestNextMarket: MarketRecord | null = null;
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
    merge: unknown;
    slug?: string;
    conditionId: string;
    upTokenId?: string;
    downTokenId?: string;
  }): Promise<void> {
    const meta = this.getRelayerMeta(params.merge);
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

  private shouldAttemptRedeem(conditionId: string, nowMs: number): boolean {
    const nextAttemptAt = this.redeemNextAttemptAtByCondition.get(conditionId);
    return nextAttemptAt === undefined || nowMs >= nextAttemptAt;
  }

  private recordRedeemNextAttempt(conditionId: string, nextAttemptAtMs: number): void {
    this.redeemNextAttemptAtByCondition.set(conditionId, nextAttemptAtMs);
  }

  private async processRedeemablePositions(positionsAddress: string): Promise<void> {
    if (!this.relayerClient.isAvailable()) {
      return;
    }

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

    const nowMs = Date.now();
    for (const conditionId of redeemableConditionIds) {
      if (!this.shouldAttemptRedeem(conditionId, nowMs)) {
        continue;
      }

      const locked = await this.withConditionLock(conditionId, async () => {
        const redeem = await this.settlementService.redeemResolvedPositions(conditionId);
        const redeemObj = redeem && typeof redeem === "object" ? (redeem as unknown as Record<string, unknown>) : null;
        const isRateLimitedSkip = redeemObj?.skipped === true && redeemObj?.reason === "relayer_rate_limited";

        if (isRateLimitedSkip) {
          const retryAtRaw = redeemObj?.retryAt;
          const retryAtMs =
            typeof retryAtRaw === "number" && Number.isFinite(retryAtRaw)
              ? retryAtRaw
              : nowMs + PolymarketBot.REDEEM_RETRY_BACKOFF_MS;
          this.recordRedeemNextAttempt(conditionId, retryAtMs);

          this.logger.warn(
            {
              conditionId,
              retryAt: retryAtRaw,
            },
            "Redeem skipped: relayer is rate limited",
          );
          await this.notify({
            title: "Redeem skipped (relayer rate limited)",
            severity: "warn",
            dedupeKey: `redeem-rate-limit:${conditionId}`,
            conditionId,
            details: [{ key: "retryAt", value: retryAtRaw as string | number | undefined }],
          });
          return;
        }

        this.recordRedeemNextAttempt(conditionId, nowMs + PolymarketBot.REDEEM_SUCCESS_COOLDOWN_MS);
        const relayerMeta = this.getRelayerMeta(redeem);
        await this.maybeNotifyRelayerFailover({
          merge: redeem,
          conditionId,
        });

        this.logger.info(
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
      });

      if (!locked.executed) {
        this.logger.debug({ conditionId }, "Redeem loop skipped condition: already in flight");
      }
    }
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

    return {
      hasAnyExposure: upSize > 0 || downSize > 0,
      reachedCap: upSize >= cap || downSize >= cap,
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

  private computeMakerMissingLegPrice(params: { bestBid: number; bestAsk: number; maxMissingPrice: number }): number {
    const bestBid = Math.max(0, params.bestBid);
    const bestAsk = Math.max(0, params.bestAsk);
    const maxMissingPrice = Math.max(0, params.maxMissingPrice);
    if (maxMissingPrice <= 0 || bestBid <= 0 || bestAsk <= 0) {
      return 0;
    }

    const makerCandidate = bestBid + this.config.entryContinuousMakerOffset;
    const nonCrossingCap = Math.max(0, bestAsk - this.config.entryContinuousMakerOffset);
    const bounded = Math.min(maxMissingPrice, makerCandidate, nonCrossingCap);
    return this.roundPrice(bounded);
  }

  private didSummaryChange(previous: PositionSummary, current: PositionSummary): boolean {
    const epsilon = 1e-6;
    return (
      Math.abs(previous.upSize - current.upSize) > epsilon || Math.abs(previous.downSize - current.downSize) > epsilon
    );
  }

  private async runContinuousMissingLegRecovery(params: {
    market: MarketRecord;
    conditionId: string;
    positionsAddress: string;
    tokenIds: TokenIds;
    initialSummary: PositionSummary;
    filledLegAvgPrice: number;
    previousPlacement?: {
      price: number;
      missingLegTokenId: string;
    };
  }): Promise<{
    status: "balanced" | "placed" | "unchanged-price" | "timeout" | "force-window" | "not-applicable";
    finalSummary: PositionSummary;
    lastPlacedPrice?: number;
    missingLegTokenId?: string;
    iterations: number;
    reason?: string;
  }> {
    const initialImbalance = this.getImbalancePlan(params.initialSummary, params.tokenIds);
    if (!initialImbalance) {
      return {
        status: "not-applicable",
        finalSummary: params.initialSummary,
        iterations: 0,
        reason: "Initial position is not imbalanced",
      };
    }

    if (!this.config.entryContinuousRepriceEnabled) {
      return {
        status: "timeout",
        finalSummary: params.initialSummary,
        iterations: 0,
        reason: "Continuous repricing disabled",
      };
    }

    const iterations = 1;
    const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(params.market);
    if (secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
      return {
        status: "force-window",
        finalSummary: params.initialSummary,
        iterations,
        reason: "Reached force-sell window during missing-leg recovery",
      };
    }

    const positions = await this.dataClient.getPositions(params.positionsAddress, params.conditionId);
    const latestSummary = summarizePositions(positions, params.tokenIds);
    const buyCapacity = this.getConditionBuyCapacity(latestSummary);
    if (buyCapacity.reachedCap) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Strict cap reached on at least one leg; no further buys allowed",
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

    const maxMissingPrice = this.roundPrice(
      1 - params.filledLegAvgPrice - this.config.forceWindowFeeBuffer - this.config.forceWindowMinProfitPerShare,
    );

    if (maxMissingPrice <= 0) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Missing-leg profitability cap is non-positive",
      };
    }

    const top = await this.tradingEngine.getTopOfBook(imbalance.missingLegTokenId);
    const nextPrice = this.computeMakerMissingLegPrice({
      bestBid: top.bestBid,
      bestAsk: top.bestAsk,
      maxMissingPrice,
    });

    if (nextPrice <= 0) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Missing-leg maker price unavailable",
      };
    }

    if (
      params.previousPlacement &&
      params.previousPlacement.missingLegTokenId === imbalance.missingLegTokenId &&
      Math.abs(nextPrice - params.previousPlacement.price) < 1e-6
    ) {
      return {
        status: "unchanged-price",
        finalSummary: latestSummary,
        iterations,
        lastPlacedPrice: nextPrice,
        missingLegTokenId: imbalance.missingLegTokenId,
        reason: "Skipped re-order because recovery price is unchanged",
      };
    }

    await this.tradingEngine.cancelEntryOpenOrders(params.tokenIds);
    const remainingForMissingLeg = this.getRemainingAllowanceForTokenId(
      imbalance.missingLegTokenId,
      params.tokenIds,
      buyCapacity,
    );
    const cappedMissingAmount = Number(Math.min(imbalance.missingAmount, remainingForMissingLeg).toFixed(6));

    if (cappedMissingAmount <= 0) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        iterations,
        reason: "Missing-leg remaining allowance is zero; no further buys allowed",
      };
    }

    await this.tradingEngine.placeSingleLimitBuyAtPrice(imbalance.missingLegTokenId, nextPrice, cappedMissingAmount);

    return {
      status: "placed",
      finalSummary: latestSummary,
      iterations,
      lastPlacedPrice: nextPrice,
      missingLegTokenId: imbalance.missingLegTokenId,
      reason:
        cappedMissingAmount < Number(imbalance.missingAmount.toFixed(6))
          ? `Placed capped missing-leg recovery order for this cycle (${cappedMissingAmount}/${Number(imbalance.missingAmount.toFixed(6))})`
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
    if (buyCapacity.reachedCap) {
      const cancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
      this.logger.warn(
        {
          conditionId,
          cancelledOpenOrders,
          summary,
          orderSizeCap: this.config.orderSize,
          secondsToClose,
        },
        "Inside force-sell window: strict cap reached, cancelled open orders and left residual imbalance",
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

    const missingLegTokenId = summary.upSize > summary.downSize ? tokenIds.downTokenId : tokenIds.upTokenId;
    const bestMissingAsk = await this.tradingEngine.getBestAskPrice(missingLegTokenId);

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
      const loaded = await this.stateStore.loadTrackedMarkets();
      for (const conditionId of loaded) {
        this.trackedMarkets.add(conditionId);
      }
    } catch (error) {
      this.logger.error(
        {
          error,
          stateFilePath: this.config.stateFilePath,
        },
        "Failed to load persisted tracked market state",
      );
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
      return;
    }

    const currentPositions = await this.dataClient.getPositions(positionsAddress, currentConditionId);
    const currentSummary = summarizePositions(currentPositions, currentTokenIds);
    const positionsEqual = arePositionsEqual(currentSummary, this.config.positionEqualityTolerance);
    const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(currentMarket);
    const nowMs = Date.now();

    const recentPlacement = this.recentRecoveryPlacements.get(currentConditionId);
    if (recentPlacement) {
      const changedSinceLastPlacement = this.didSummaryChange(recentPlacement.summary, currentSummary);
      const placementExpired = nowMs - recentPlacement.placedAtMs >= PolymarketBot.RECOVERY_REARM_COOLDOWN_MS;
      if (positionsEqual || changedSinceLastPlacement || placementExpired) {
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

    this.logger.info(
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
        merge,
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

      const imbalancePlan = this.getImbalancePlan(currentSummary, currentTokenIds);
      if (!imbalancePlan) {
        this.logger.info(
          {
            conditionId: currentConditionId,
            slug: currentMarket.slug,
            up: currentSummary.upSize,
            down: currentSummary.downSize,
            diff: currentSummary.differenceAbs,
            secondsToClose,
          },
          "Observed non-recoverable imbalance outside force-sell window; no action taken",
        );
        return;
      }

      const recovery = await this.runContinuousMissingLegRecovery({
        market: currentMarket,
        conditionId: currentConditionId,
        positionsAddress,
        tokenIds: currentTokenIds,
        initialSummary: currentSummary,
        filledLegAvgPrice: this.config.orderPrice,
        previousPlacement: placementLock
          ? {
              price: placementLock.price,
              missingLegTokenId: placementLock.missingLegTokenId,
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
        this.logger.info(
          {
            conditionId: currentConditionId,
            slug: currentMarket.slug,
            summary: recovery.finalSummary,
            lastPlacedPrice: recovery.lastPlacedPrice,
            reason: recovery.reason,
            cooldownMs: PolymarketBot.RECOVERY_REARM_COOLDOWN_MS,
            secondsToClose,
          },
          "Skipped recovery re-order because price is unchanged",
        );
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
      return this.config.loopSleepSeconds;
    }

    this.clobWsClient.ensureSubscribed([entryTokenIds.upTokenId, entryTokenIds.downTokenId]);

    const entryConditionId = this.marketDiscovery.getConditionId(entryMarket);
    if (!entryConditionId) {
      this.logger.warn({ slug: entryMarket.slug }, "Entry market missing condition ID");
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

    const paired = await this.tradingEngine.placePairedLimitBuysAtPrice(entryTokenIds, entryPrice, this.config.orderSize);
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
      this.transitionConditionLifecycle(entryConditionId, isInsideForceSellWindow ? "force-window" : "recovery-pending");
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
    }
  }

  private async discoveryLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.updateMarketSnapshot();
      } catch (error) {
        this.logger.error({ error }, "Discovery loop error");
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
      }

      await sleep(this.config.loopSleepSeconds);
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
