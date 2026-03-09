import type { Logger } from "pino";
import type { BotConfig, MarketRecord } from "./types/domain.js";
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

export class PolymarketBot {
  private stopped = false;
  private readonly enteredMarkets = new Set<string>();
  private readonly notifiedPlacementSuccess = new Set<string>();
  private readonly mergeAttemptedMarkets = new Set<string>();
  private readonly inFlightConditions = new Set<string>();

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

  private async markEnteredMarket(conditionId: string): Promise<void> {
    this.enteredMarkets.add(conditionId);
    try {
      await this.stateStore.saveEnteredMarkets(this.enteredMarkets);
    } catch (error) {
      this.logger.error(
        {
          error,
          stateFilePath: this.config.stateFilePath,
          conditionId,
        },
        "Failed to persist entered market state",
      );
    }
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

  private async loadPersistedEnteredMarkets(): Promise<void> {
    try {
      const loaded = await this.stateStore.loadEnteredMarkets();
      for (const conditionId of loaded) {
        this.enteredMarkets.add(conditionId);
      }
    } catch (error) {
      this.logger.error(
        {
          error,
          stateFilePath: this.config.stateFilePath,
        },
        "Failed to load persisted entered market state",
      );
    }
  }

  private async processCurrentEnteredMarket(params: {
    currentMarket: MarketRecord;
    currentConditionId: string;
    positionsAddress: string;
  }): Promise<void> {
    const { currentMarket, currentConditionId, positionsAddress } = params;

    const currentTokenIds = this.marketDiscovery.getTokenIds(currentMarket);
    if (!currentTokenIds) {
      this.logger.warn(
        { slug: currentMarket.slug, conditionId: currentConditionId },
        "Current entered market missing token IDs",
      );
      return;
    }

    const currentPositions = await this.dataClient.getPositions(positionsAddress, currentConditionId);
    const currentSummary = summarizePositions(currentPositions, currentTokenIds);
    const positionsEqual = arePositionsEqual(currentSummary, this.config.positionEqualityTolerance);
    const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(currentMarket);

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

    if (
      positionsEqual &&
      currentSummary.upSize > 0 &&
      this.relayerClient.isAvailable() &&
      !this.mergeAttemptedMarkets.has(currentConditionId)
    ) {
      const amount = Math.min(currentSummary.upSize, currentSummary.downSize);
      const merge = await this.settlementService.mergeEqualPositions(currentConditionId, amount);
      const mergeObj = merge && typeof merge === "object" ? (merge as Record<string, unknown>) : null;
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

      this.mergeAttemptedMarkets.add(currentConditionId);
      this.logger.info({ merge, conditionId: currentConditionId }, "Merge flow executed");
      return;
    }

    if (!positionsEqual && secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
      const forceSell = await this.tradingEngine.forceSellAll(currentSummary, currentTokenIds);
      this.logger.info({ forceSell, conditionId: currentConditionId }, "Force sell flow executed");
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

    this.logger.info(
      {
        slug: entryMarket.slug,
        conditionId: entryConditionId,
        upTokenId: entryTokenIds.upTokenId,
        downTokenId: entryTokenIds.downTokenId,
      },
      "Evaluating entry market",
    );

    if (this.enteredMarkets.has(entryConditionId)) {
      this.logger.info(
        {
          conditionId: entryConditionId,
          slug: entryMarket.slug,
        },
        "Skipped new entry: market already has one paired entry",
      );
      return this.config.loopSleepSeconds;
    }

    const maxEntryPrice = this.tradingEngine.getEntryPriceForAttempt(this.config.entryMaxRepriceAttempts);
    const requiredUsdcForBothLegs = maxEntryPrice * this.config.orderSize * 2;
    const currentUsdcBalance = await this.clobClient.getUsdcBalance();
    if (currentUsdcBalance < requiredUsdcForBothLegs) {
      this.logger.warn(
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
      await this.markEnteredMarket(entryConditionId);
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
        flattenOnImbalance: isFinalAttempt && !isInsideForceSellWindow,
        cancelOpenOrders: !isInsideForceSellWindow,
      });

      if (isInsideForceSellWindow && isFinalAttempt && reconcile.status === "imbalanced") {
        const missingLegTokenId =
          reconcile.finalSummary.upSize > reconcile.finalSummary.downSize
            ? entryTokenIds.downTokenId
            : entryTokenIds.upTokenId;
        const bestMissingAsk = await this.tradingEngine.getBestAskPrice(missingLegTokenId);

        if (Number.isFinite(bestMissingAsk) && bestMissingAsk > 0) {
          const hedgeCheck = this.evaluateForceWindowHedge(entryPrice, bestMissingAsk);

          if (hedgeCheck.isProfitable) {
            const cancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(entryTokenIds);
            const hedgeBuy = await this.tradingEngine.completeMissingLegForHedge(
              reconcile.finalSummary,
              entryTokenIds,
              hedgeCheck.maxHedgePrice,
            );

            this.logger.warn(
              {
                conditionId: entryConditionId,
                bestMissingAsk,
                maxHedgePrice: hedgeCheck.maxHedgePrice,
                expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
                cancelledOpenOrders,
                hedgeBuy,
                secondsToClose,
              },
              "Inside force-sell window: completed missing leg because hedge was profitable",
            );

            const postHedgeReconcile = await this.tradingEngine.reconcilePairedEntry({
              positionsAddress,
              conditionId: entryConditionId,
              tokenIds: entryTokenIds,
              flattenOnImbalance: true,
              cancelOpenOrders: true,
            });

            if (postHedgeReconcile.status === "balanced") {
              await this.markEnteredMarket(entryConditionId);
              this.logger.info(
                {
                  conditionId: entryConditionId,
                  bestMissingAsk,
                  maxHedgePrice: hedgeCheck.maxHedgePrice,
                  expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
                  summary: postHedgeReconcile.finalSummary,
                },
                "Late hedge completion produced balanced position",
              );
              return this.config.positionRecheckSeconds;
            }

            this.logger.warn(
              {
                conditionId: entryConditionId,
                bestMissingAsk,
                maxHedgePrice: hedgeCheck.maxHedgePrice,
                expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
                summary: postHedgeReconcile.finalSummary,
              },
              "Late hedge completion still imbalanced; flattening residual position",
            );

            const flattenAfterHedge = await this.tradingEngine.forceSellAll(
              postHedgeReconcile.finalSummary,
              entryTokenIds,
            );
            this.logger.warn(
              {
                conditionId: entryConditionId,
                flattenAfterHedge,
                summary: postHedgeReconcile.finalSummary,
              },
              "Flattened residual after unsuccessful late hedge completion",
            );
            return this.config.loopSleepSeconds;
          }

          const cancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(entryTokenIds);
          const forceSell = await this.tradingEngine.forceSellAll(reconcile.finalSummary, entryTokenIds);
          this.logger.warn(
            {
              conditionId: entryConditionId,
              bestMissingAsk,
              maxHedgePrice: hedgeCheck.maxHedgePrice,
              expectedLockPnlPerShare: hedgeCheck.expectedLockPnlPerShare,
              cancelledOpenOrders,
              forceSell,
              summary: reconcile.finalSummary,
              secondsToClose,
            },
            "Inside force-sell window: hedge not profitable, cancelled open orders and flattened filled position",
          );
          await this.notify({
            title: "Force-window fallback flattened (hedge not profitable)",
            severity: "warn",
            dedupeKey: `force-window-flatten:${entryConditionId}`,
            slug: entryMarket.slug,
            conditionId: entryConditionId,
            upTokenId: entryTokenIds.upTokenId,
            downTokenId: entryTokenIds.downTokenId,
            details: [
              { key: "bestMissingAsk", value: bestMissingAsk },
              { key: "maxHedgePrice", value: hedgeCheck.maxHedgePrice },
              { key: "expectedLockPnlPerShare", value: hedgeCheck.expectedLockPnlPerShare },
              { key: "up", value: reconcile.finalSummary.upSize },
              { key: "down", value: reconcile.finalSummary.downSize },
              { key: "diff", value: reconcile.finalSummary.differenceAbs },
              { key: "secondsToClose", value: secondsToClose },
            ],
          });
          return this.config.loopSleepSeconds;
        }

        const cancelledOpenOrders = await this.tradingEngine.cancelEntryOpenOrders(entryTokenIds);
        const forceSell = await this.tradingEngine.forceSellAll(reconcile.finalSummary, entryTokenIds);
        this.logger.warn(
          {
            conditionId: entryConditionId,
            bestMissingAsk,
            cancelledOpenOrders,
            forceSell,
            summary: reconcile.finalSummary,
            secondsToClose,
          },
          "Inside force-sell window: missing-leg price unavailable, cancelled open orders and flattened filled position",
        );
        await this.notify({
          title: "Force-window fallback flattened (missing-leg price unavailable)",
          severity: "warn",
          dedupeKey: `force-window-missing-price:${entryConditionId}`,
          slug: entryMarket.slug,
          conditionId: entryConditionId,
          upTokenId: entryTokenIds.upTokenId,
          downTokenId: entryTokenIds.downTokenId,
          details: [
            { key: "up", value: reconcile.finalSummary.upSize },
            { key: "down", value: reconcile.finalSummary.downSize },
            { key: "diff", value: reconcile.finalSummary.differenceAbs },
            { key: "secondsToClose", value: secondsToClose },
          ],
        });
        return this.config.loopSleepSeconds;
      }

      if (reconcile.status === "balanced") {
        await this.markEnteredMarket(entryConditionId);
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

      if (reconcile.status === "flattened") {
        this.logger.warn(
          {
            conditionId: entryConditionId,
            status: reconcile.status,
            attempts: reconcile.attempts,
            summary: reconcile.finalSummary,
            cancelledOpenOrders: reconcile.cancelledOpenOrders,
            flattenResult: reconcile.flattenResult,
            reason: reconcile.reason,
            entryAttempt: attempt,
            entryPrice,
          },
          "Entry reconciliation flattened imbalanced exposure",
        );
        await this.notify({
          title: "Entry reconciliation flattened",
          severity: "warn",
          dedupeKey: `reconcile-flattened:${entryConditionId}`,
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
        if (currentConditionId && this.enteredMarkets.has(currentConditionId)) {
          const locked = await this.withConditionLock(currentConditionId, async () => {
            await this.processCurrentEnteredMarket({
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

  async runForever(): Promise<void> {
    await this.clobClient.init();
    this.clobWsClient.start();
    const userAddress = this.clobClient.getSignerAddress();
    const positionsAddress = this.config.funder ?? userAddress;

    await this.loadPersistedEnteredMarkets();

    this.logger.info(
      {
        dryRun: this.config.dryRun,
        userAddress,
        positionsAddress,
        relayerEnabled: this.relayerClient.isAvailable(),
        persistedEnteredMarketCount: this.enteredMarkets.size,
        stateFilePath: this.config.stateFilePath,
      },
      "Bot initialized",
    );

    await this.updateMarketSnapshot();
    await Promise.all([
      this.discoveryLoop(),
      this.currentMarketLoop(positionsAddress),
      this.entryLoop(positionsAddress),
    ]);

    this.logger.info("Bot stopped");
  }
}
