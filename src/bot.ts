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
import {
  computeMakerMissingLegPrice,
  evaluateForceWindowHedge,
  getImbalancePlan,
} from "./domain/recoveryPolicy.js";
import { selectEntryMarket } from "./domain/entryPolicy.js";
import { getSnapshotAgeMs, isSnapshotStale } from "./domain/marketPolicy.js";
import { runDiscoveryLoopEffect } from "./workflows/discovery.workflow.js";
import { runCurrentMarketLoopEffect } from "./workflows/currentMarket.workflow.js";
import { runEntryLoopEffect } from "./workflows/entry.workflow.js";
import { runTelegramLoopEffect } from "./workflows/telegram.workflow.js";
import { Effect } from "effect";

export class PolymarketBot {
  private stopped = false;
  private readonly trackedMarkets = new Set<string>();
  private readonly notifiedPlacementSuccess = new Set<string>();
  private readonly mergeAttemptedMarkets = new Set<string>();
  private readonly balancedOrderCleanupDone = new Set<string>();
  private readonly inFlightConditions = new Set<string>();
  private readonly notifiedEntryFilled = new Set<string>();
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
    upTokenId: string;
    downTokenId: string;
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

  stop(): void {
    this.stopped = true;
    this.clobWsClient.stop();
  }

  async init(): Promise<{ userAddress: string; positionsAddress: string }> {
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
        { key: "entryRepriceAttempts", value: this.config.entryMaxRepriceAttempts },
        { key: "entryMaxSpread", value: this.config.entryMaxSpread },
        { key: "wsEnabled", value: this.config.enableClobWs ? "true" : "false" },
        { key: "relayerEnabled", value: this.relayerClient.isAvailable() ? "true" : "false" },
        { key: "availableBuilders", value: this.relayerClient.getAvailableBuilderLabels().join(", ") || "none" },
      ],
    });

    await this.updateMarketSnapshot();
    return { userAddress, positionsAddress };
  }

  async runDiscovery(): Promise<void> {
    await this.discoveryLoop();
  }

  async runCurrentMarket(positionsAddress: string): Promise<void> {
    await this.currentMarketLoop(positionsAddress);
  }

  async runEntry(positionsAddress: string): Promise<void> {
    await this.entryLoop(positionsAddress);
  }

  async runTelegram(): Promise<void> {
    await this.telegramCommandLoop();
  }

  async finalize(): Promise<void> {
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

  private getSnapshotAgeMs(): number | null {
    return getSnapshotAgeMs(this.snapshotUpdatedAtMs);
  }

  private isSnapshotStale(): boolean {
    return isSnapshotStale({
      snapshotUpdatedAtMs: this.snapshotUpdatedAtMs,
      loopSleepSeconds: this.config.loopSleepSeconds,
    });
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

  private roundPrice(price: number): number {
    return Number(price.toFixed(4));
  }

  private async runContinuousMissingLegRecovery(params: {
    market: MarketRecord;
    conditionId: string;
    positionsAddress: string;
    tokenIds: TokenIds;
    initialSummary: PositionSummary;
    filledLegAvgPrice: number;
  }): Promise<{
    status: "balanced" | "timeout" | "force-window" | "not-applicable";
    finalSummary: PositionSummary;
    lastPlacedPrice?: number;
    iterations: number;
    reason?: string;
  }> {
    const initialImbalance = getImbalancePlan(params.initialSummary, params.tokenIds);
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

    let lastPlacedPrice: number | undefined;
    let latestSummary = params.initialSummary;
    const iterations = 1;

    if (this.stopped) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        lastPlacedPrice,
        iterations: 0,
        reason: "Bot is stopping",
      };
    }

    const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(params.market);
    if (secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
      return {
        status: "force-window",
        finalSummary: latestSummary,
        lastPlacedPrice,
        iterations,
        reason: "Reached force-sell window during continuous repricing",
      };
    }

    const positions = await this.dataClient.getPositions(params.positionsAddress, params.conditionId);
    latestSummary = summarizePositions(positions, params.tokenIds);
    if (latestSummary.upSize > 0 && latestSummary.downSize > 0 && arePositionsEqual(latestSummary, this.config.positionEqualityTolerance)) {
      return {
        status: "balanced",
        finalSummary: latestSummary,
        lastPlacedPrice,
        iterations,
      };
    }

    const imbalance = getImbalancePlan(latestSummary, params.tokenIds);
    if (!imbalance) {
      return {
        status: "not-applicable",
        finalSummary: latestSummary,
        lastPlacedPrice,
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
        lastPlacedPrice,
        iterations,
        reason: "Missing-leg profitability cap is non-positive",
      };
    }

    const top = await this.tradingEngine.getTopOfBook(imbalance.missingLegTokenId);
    const nextPrice = computeMakerMissingLegPrice({
      bestBid: top.bestBid,
      bestAsk: top.bestAsk,
      maxMissingPrice,
      entryContinuousMakerOffset: this.config.entryContinuousMakerOffset,
    });

    if (nextPrice <= 0) {
      return {
        status: "timeout",
        finalSummary: latestSummary,
        lastPlacedPrice,
        iterations,
        reason: "Missing-leg quote not actionable",
      };
    }

    await this.tradingEngine.cancelEntryOpenOrders(params.tokenIds);
    await this.tradingEngine.placeSingleLimitBuyAtPrice(
      imbalance.missingLegTokenId,
      nextPrice,
      Number(imbalance.missingAmount.toFixed(6)),
    );
    lastPlacedPrice = nextPrice;

    return {
      status: "timeout",
      finalSummary: latestSummary,
      lastPlacedPrice,
      iterations,
      reason: "Placed a single missing-leg recovery order",
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
    const missingLegTokenId = summary.upSize > summary.downSize ? tokenIds.downTokenId : tokenIds.upTokenId;
    const bestMissingAsk = await this.tradingEngine.getBestAskPrice(missingLegTokenId);

    if (Number.isFinite(bestMissingAsk) && bestMissingAsk > 0) {
      const hedgeCheck = evaluateForceWindowHedge({
        entryPrice,
        bestMissingAsk,
        forceWindowFeeBuffer: this.config.forceWindowFeeBuffer,
        forceWindowMinProfitPerShare: this.config.forceWindowMinProfitPerShare,
      });

      if (hedgeCheck.isProfitable) {
        const cancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
        const hedgeBuy = await this.tradingEngine.completeMissingLegForHedge(summary, tokenIds, hedgeCheck.maxHedgePrice);
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

    if (!positionsEqual) {
      this.balancedOrderCleanupDone.delete(currentConditionId);
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
      const imbalancePlan = getImbalancePlan(currentSummary, currentTokenIds);
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
      });

      if (recovery.status === "balanced") {
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

      this.logger.info(
        { conditionId: currentConditionId, secondsToClose, summary: currentSummary },
        "Recovered imbalanced current market inside force-sell window",
      );
    }
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

    const maxEntryPrice = this.tradingEngine.getEntryPriceForAttempt(this.config.entryMaxRepriceAttempts);
    const requiredUsdcForBothLegs = maxEntryPrice * this.config.orderSize * 2;
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
      const entryPrice = this.tradingEngine.getEntryPriceForAttempt(0);
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
      this.logger.info(
        {
          conditionId: entryConditionId,
          slug: entryMarket.slug,
        },
        "Deferred recovery for non-current market until it becomes current",
      );
      return this.config.loopSleepSeconds;
    }

    const maxRepriceAttempts = isInsideForceSellWindow ? 0 : this.config.entryMaxRepriceAttempts;

    for (let attempt = 0; attempt <= maxRepriceAttempts; attempt += 1) {
      const entryPrice = this.tradingEngine.getEntryPriceForAttempt(attempt);
      const liquidity = await this.tradingEngine.evaluateLiquidityForEntry(entryTokenIds, entryPrice);
      if (!liquidity.allowed) {
        this.logger.warn(
          {
            conditionId: entryConditionId,
            attempt,
            entryPrice,
            reason: liquidity.reason,
            upSpread: liquidity.upSpread,
            downSpread: liquidity.downSpread,
            upDepth: liquidity.upDepth,
            downDepth: liquidity.downDepth,
            secondsToClose,
            forceSellThresholdSeconds: this.config.forceSellThresholdSeconds,
          },
          "Skipped entry attempt due to liquidity/spread gate",
        );
        return this.config.loopSleepSeconds;
      }

      const paired = await this.tradingEngine.placePairedLimitBuysAtPrice(
        entryTokenIds,
        entryPrice,
        liquidity.orderSize,
      );
      this.logger.info(
        {
          paired,
          conditionId: entryConditionId,
          entryPrice,
          orderSize: liquidity.orderSize,
          attempt,
          maxAttempts: maxRepriceAttempts,
          upSpread: liquidity.upSpread,
          downSpread: liquidity.downSpread,
          upDepth: liquidity.upDepth,
          downDepth: liquidity.downDepth,
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
        orderSize: liquidity.orderSize,
        attempt,
        secondsToClose,
        mode: "current-market",
      });

      const isFinalAttempt = attempt >= maxRepriceAttempts;
      const reconcile = await this.tradingEngine.reconcilePairedEntry({
        positionsAddress,
        conditionId: entryConditionId,
        tokenIds: entryTokenIds,
        cancelOpenOrders: !isInsideForceSellWindow,
      });

      if (isInsideForceSellWindow && isFinalAttempt && reconcile.status === "imbalanced") {
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
        this.logger.info(
          {
            conditionId: entryConditionId,
            status: reconcile.status,
            attempts: reconcile.attempts,
            summary: reconcile.finalSummary,
            entryAttempt: attempt,
            entryPrice,
          },
          "Entry reconciliation succeeded",
        );
        return this.config.positionRecheckSeconds;
      }

      if (reconcile.status === "imbalanced" && !isFinalAttempt) {
        this.logger.warn(
          {
            conditionId: entryConditionId,
            status: reconcile.status,
            attempts: reconcile.attempts,
            summary: reconcile.finalSummary,
            cancelledOpenOrders: reconcile.cancelledOpenOrders,
            reason: reconcile.reason,
            entryAttempt: attempt,
            nextPrice: this.tradingEngine.getEntryPriceForAttempt(attempt + 1),
            secondsToClose,
          },
          "Entry remains imbalanced; repricing paired entry",
        );
        continue;
      }

      if (reconcile.status === "imbalanced") {
        this.logger.warn(
          {
            conditionId: entryConditionId,
            status: reconcile.status,
            attempts: reconcile.attempts,
            summary: reconcile.finalSummary,
            cancelledOpenOrders: reconcile.cancelledOpenOrders,
            reason: reconcile.reason,
            entryAttempt: attempt,
            entryPrice,
            secondsToClose,
            forceSellWindow: isInsideForceSellWindow,
          },
          "Entry reconciliation ended imbalanced; keeping residual exposure",
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
            { key: "attempt", value: attempt },
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

      this.logger.error(
        {
          conditionId: entryConditionId,
          status: reconcile.status,
          attempts: reconcile.attempts,
          summary: reconcile.finalSummary,
          cancelledOpenOrders: reconcile.cancelledOpenOrders,
          reason: reconcile.reason,
          entryAttempt: attempt,
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
          { key: "attempt", value: attempt },
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
    await Effect.runPromise(
      runDiscoveryLoopEffect({
        loopSleepSeconds: this.config.loopSleepSeconds,
        isStopped: () => this.stopped,
        updateSnapshot: () => this.updateMarketSnapshot(),
        onError: async (error) => {
          this.logger.error({ error }, "Discovery loop error");
        },
        sleep: (seconds) => sleep(seconds),
      }),
    );
  }

  private async currentMarketLoop(positionsAddress: string): Promise<void> {
    await Effect.runPromise(
      runCurrentMarketLoopEffect({
        isStopped: () => this.stopped,
        isSnapshotStale: () => this.isSnapshotStale(),
        getSnapshotAgeMs: () => this.getSnapshotAgeMs(),
        sleep: (seconds) => sleep(seconds),
        currentLoopSleepSeconds: this.config.currentLoopSleepSeconds,
        getCurrentMarketConditionId: () => {
          const currentMarket = this.latestCurrentMarket;
          return currentMarket ? this.marketDiscovery.getConditionId(currentMarket) : null;
        },
        isTrackedCondition: (conditionId) => this.trackedMarkets.has(conditionId),
        withConditionLock: (conditionId, run) => this.withConditionLock(conditionId, run),
        processTrackedCurrentMarket: async () => {
          const currentMarket = this.latestCurrentMarket;
          if (!currentMarket) {
            return;
          }

          const currentConditionId = this.marketDiscovery.getConditionId(currentMarket);
          if (!currentConditionId) {
            return;
          }

          await this.processTrackedCurrentMarket({
            currentMarket,
            currentConditionId,
            positionsAddress,
          });
        },
        onDebug: async (message, context) => {
          this.logger.debug(context, message);
        },
        onWarn: async (message, context) => {
          this.logger.warn(context, message);
        },
        onError: async (error) => {
          this.logger.error({ error }, "Current market loop error");
        },
      }),
    );
  }

  private async processTelegramCommands(): Promise<void> {
    if (!this.telegramClient.isEnabled()) {
      return;
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
  }

  private async telegramCommandLoop(): Promise<void> {
    await Effect.runPromise(
      runTelegramLoopEffect({
        isStopped: () => this.stopped,
        loopSleepSeconds: this.config.loopSleepSeconds,
        sleep: (seconds) => sleep(seconds),
        processCommands: () => this.processTelegramCommands(),
        onWarn: async (error) => {
          this.logger.warn({ error }, "Telegram command loop error");
        },
      }),
    );
  }

  private async entryLoop(positionsAddress: string): Promise<void> {
    await Effect.runPromise(
      runEntryLoopEffect({
        isStopped: () => this.stopped,
        isSnapshotStale: () => this.isSnapshotStale(),
        getSnapshotAgeMs: () => this.getSnapshotAgeMs(),
        loopSleepSeconds: this.config.loopSleepSeconds,
        sleep: (seconds) => sleep(seconds),
        resolveEntryConditionId: () => {
          const currentMarket = this.latestCurrentMarket;
          const nextMarket = this.latestNextMarket;

          if (!currentMarket && !nextMarket) {
            return null;
          }

          const currentConditionId = currentMarket ? this.marketDiscovery.getConditionId(currentMarket) : null;
          const entryMarket = selectEntryMarket({
            currentMarket,
            nextMarket,
            currentConditionId,
            getConditionId: (market) => this.marketDiscovery.getConditionId(market),
          });

          if (!entryMarket) {
            return null;
          }

          return this.marketDiscovery.getConditionId(entryMarket);
        },
        processEntry: async () => {
          const currentMarket = this.latestCurrentMarket;
          const nextMarket = this.latestNextMarket;

          if (!currentMarket && !nextMarket) {
            return this.config.loopSleepSeconds;
          }

          const currentConditionId = currentMarket ? this.marketDiscovery.getConditionId(currentMarket) : null;
          const entryMarket = selectEntryMarket({
            currentMarket,
            nextMarket,
            currentConditionId,
            getConditionId: (market) => this.marketDiscovery.getConditionId(market),
          });

          if (!entryMarket) {
            this.logger.info("No market available for new entry");
            return this.config.loopSleepSeconds;
          }

          return this.processEntryMarket({
            entryMarket,
            currentConditionId,
            positionsAddress,
          });
        },
        withConditionLock: (conditionId, run) => this.withConditionLock(conditionId, run),
        onDebug: async (message, context) => {
          this.logger.debug(context, message);
        },
        onWarn: async (message, context) => {
          this.logger.warn(context, message);
        },
        onError: async (error) => {
          this.logger.error({ error }, "Entry loop error");
        },
      }),
    );
  }

}
