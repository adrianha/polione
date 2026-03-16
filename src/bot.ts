import type { Logger } from "pino";
import type {
  BotConfig,
  MarketRecord,
  PositionSummary,
  RedeemStateRecord,
  TokenIds,
} from "./types/domain.js";
import { GammaClient } from "./clients/gammaClient.js";
import { PolyClobClient } from "./clients/clobClient.js";
import { TelegramClient } from "./clients/telegramClient.js";
import { PolyRelayerClient } from "./clients/relayerClient.js";
import { DataClient } from "./clients/dataClient.js";
import { MarketDiscoveryService } from "./services/marketDiscovery.js";
import { TradingEngine } from "./services/tradingEngine.js";
import { SettlementService } from "./services/settlement.js";
import { RedeemPrecheckService } from "./services/redeemPrecheck.js";
import { StateStore } from "./utils/stateStore.js";
import {
  type ConditionLifecycle,
  type ConditionRuntimeState,
  type CurrentMarketResult,
  type EntryOpportunityResult,
  type MarketContext,
  type MarketTaskOutcome,
  type MarketTaskSignal,
  type RecoveryPlacementRecord,
} from "./bot/marketFlowTypes.js";
import {
  processEntryMarket as processEntryMarketFlow,
  selectEntryMarket as selectEntryMarketFlow,
} from "./bot/entryFlow.js";
import { processRedeemablePositions as processRedeemablePositionsFlow } from "./bot/redeemFlow.js";
import {
  processTrackedCurrentMarket as processTrackedCurrentMarketFlow,
  noteCurrentMarketContext as noteCurrentMarketContextFlow,
  runContinuousMissingLegRecovery as runContinuousMissingLegRecoveryFlow,
  handleForceWindowImbalance as handleForceWindowImbalanceFlow,
} from "./bot/trackedMarketFlow.js";
import {
  formatTelegramMessage as formatTelegramMessageFlow,
  notify as notifyFlow,
  notifyEntryFilledOnce as notifyEntryFilledOnceFlow,
  notifyOperationalIssue as notifyOperationalIssueFlow,
  notifyPlacementSuccessOnce as notifyPlacementSuccessOnceFlow,
} from "./bot/notificationService.js";
import { runScheduler } from "./bot/scheduler.js";
import {
  createRecoveryPlacementsFacade,
  createTrackedMarketsFacade,
  getConditionState as getConditionStateFlow,
  loadPersistedTrackedMarkets as loadPersistedTrackedMarketsFlow,
  markTrackedMarket as markTrackedMarketFlow,
  patchConditionState as patchConditionStateFlow,
  transitionConditionLifecycle as transitionConditionLifecycleFlow,
} from "./bot/runtimeState.js";
import type { BotDomainContext } from "./bot/botContext.js";

export class PolymarketBot {
  private readonly context = this as unknown as BotDomainContext;
  private stopped = false;
  private readonly conditionStates = new Map<string, ConditionRuntimeState>();
  private readonly trackedMarkets = createTrackedMarketsFacade(this.context);
  private readonly redeemStates = new Map<string, RedeemStateRecord>();
  private readonly recentRecoveryPlacements = createRecoveryPlacementsFacade(this.context);
  private readonly inFlightConditions = new Set<string>();
  private relayerFailoverActive = false;

  private readonly gammaClient: GammaClient;
  private readonly clobClient: PolyClobClient;
  private readonly relayerClient: PolyRelayerClient;
  private readonly dataClient: DataClient;
  private readonly marketDiscovery: MarketDiscoveryService;
  private readonly tradingEngine: TradingEngine;
  private readonly settlementService: SettlementService;
  private readonly redeemPrecheckService: RedeemPrecheckService;
  private readonly telegramClient: TelegramClient;
  private readonly stateStore: StateStore;
  private activeCurrentConditionId: string | null = null;
  private activeCurrentTokenIds: TokenIds | null = null;
  private telegramOffset: number | undefined;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {
    this.gammaClient = new GammaClient(config);
    this.clobClient = new PolyClobClient(config);
    this.relayerClient = new PolyRelayerClient(config);
    this.dataClient = new DataClient(config);
    this.marketDiscovery = new MarketDiscoveryService(config, this.gammaClient);
    this.tradingEngine = new TradingEngine(config, this.clobClient, this.dataClient);
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
    return formatTelegramMessageFlow(this.context, params);
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
    await notifyFlow(this.context, params);
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
    await notifyOperationalIssueFlow(this.context, params);
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
    await notifyPlacementSuccessOnceFlow(this.context, params);
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
    await notifyEntryFilledOnceFlow(this.context, params);
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

  private noteCurrentMarketContext(conditionId: string, tokenIds: TokenIds): void {
    noteCurrentMarketContextFlow(this.context, conditionId, tokenIds);
  }

  private getConditionState(conditionId: string): ConditionRuntimeState {
    return getConditionStateFlow(this.context, conditionId);
  }

  private patchConditionState(
    conditionId: string,
    patch: Partial<ConditionRuntimeState>,
  ): ConditionRuntimeState {
    return patchConditionStateFlow(this.context, conditionId, patch);
  }

  private async runContinuousMissingLegRecovery(params: {
    market: MarketRecord;
    conditionId: string;
    positionsAddress: string;
    tokenIds: TokenIds;
    currentSummary: PositionSummary;
    filledLegAvgPrice: number;
    previousPlacement?: RecoveryPlacementRecord;
  }): Promise<any> {
    return runContinuousMissingLegRecoveryFlow(this.context, params);
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
    return handleForceWindowImbalanceFlow(this.context, params);
  }

  private async processTrackedCurrentMarket(params: {
    currentMarket: MarketRecord;
    currentConditionId: string;
    positionsAddress: string;
  }): Promise<CurrentMarketResult> {
    return processTrackedCurrentMarketFlow(this.context, params);
  }

  private selectEntryMarket(params: MarketContext): MarketRecord | null {
    return selectEntryMarketFlow(this.context, params);
  }

  private async processEntryMarket(params: {
    entryMarket: MarketRecord;
    currentConditionId: string | null;
    positionsAddress: string;
  }): Promise<EntryOpportunityResult> {
    return processEntryMarketFlow(this.context, params);
  }

  private async processRedeemablePositions(positionsAddress: string): Promise<void> {
    return processRedeemablePositionsFlow(this.context, positionsAddress);
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

  private async markTrackedMarket(conditionId: string): Promise<void> {
    await markTrackedMarketFlow(this.context, conditionId);
  }

  private transitionConditionLifecycle(conditionId: string, state: ConditionLifecycle): void {
    transitionConditionLifecycleFlow(this.context, conditionId, state);
  }

  stop(): void {
    this.stopped = true;
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

  private async loadPersistedTrackedMarkets(): Promise<void> {
    await loadPersistedTrackedMarketsFlow(this.context);
  }

  private async discoverMarketContext(): Promise<MarketContext> {
    const [currentMarket, nextMarket] = await Promise.all([
      this.marketDiscovery.findCurrentActiveMarket(),
      this.marketDiscovery.findNextActiveMarket(),
    ]);

    if (!currentMarket && !nextMarket) {
      this.logger.warn("No active market found, retrying");
      await this.notifyOperationalIssue({
        title: "No active market found",
        severity: "warn",
        dedupeKey: "no-active-market",
      });
    }

    return {
      currentMarket,
      nextMarket,
      currentConditionId: currentMarket ? this.marketDiscovery.getConditionId(currentMarket) : null,
    };
  }

  private combineMarketTaskOutcomes(
    currentResult: CurrentMarketResult,
    entryResult: EntryOpportunityResult,
  ): MarketTaskOutcome {
    const priorities: MarketTaskOutcome[] = [
      "force-window",
      "recovery-placed",
      "recovery-needed",
      "balanced",
      "entered",
      "failed",
      "idle",
    ];
    const candidates: MarketTaskOutcome[] = [currentResult.outcome, entryResult.outcome];
    return priorities.find((outcome) => candidates.includes(outcome)) ?? "idle";
  }

  private computeNextMarketInterval(signal: MarketTaskSignal): number {
    if (
      signal.outcome !== "idle" ||
      signal.hasTrackedExposure ||
      (signal.secondsToClose !== null &&
        signal.secondsToClose <= this.config.forceSellThresholdSeconds + 30)
    ) {
      return this.config.marketUrgentPollMs;
    }

    return this.config.marketPollMs;
  }

  private async runMarketTask(positionsAddress: string): Promise<MarketTaskSignal> {
    const context = await this.discoverMarketContext();

    let currentResult: CurrentMarketResult = {
      outcome: "idle",
      hasTrackedExposure: false,
      secondsToClose: null,
    };

    if (context.currentMarket && context.currentConditionId && this.trackedMarkets.has(context.currentConditionId)) {
      const locked = await this.withConditionLock(context.currentConditionId, async () => {
        return this.processTrackedCurrentMarket({
          currentMarket: context.currentMarket as MarketRecord,
          currentConditionId: context.currentConditionId as string,
          positionsAddress,
        });
      });

      if (!locked.executed) {
        this.logger.debug(
          { conditionId: context.currentConditionId },
          "Market task skipped tracked condition: already in flight",
        );
        currentResult = {
          outcome: "recovery-needed",
          hasTrackedExposure: true,
          secondsToClose: this.marketDiscovery.getSecondsToMarketClose(context.currentMarket),
        };
      } else if (locked.result) {
        currentResult = locked.result;
      }
    }

    let entryResult: EntryOpportunityResult = {
      outcome: "idle",
      secondsToClose: currentResult.secondsToClose,
    };
    const entryMarket = this.selectEntryMarket(context);

    if (entryMarket) {
      const entryConditionId = this.marketDiscovery.getConditionId(entryMarket);
      if (!entryConditionId) {
        entryResult = await this.processEntryMarket({
          entryMarket,
          currentConditionId: context.currentConditionId,
          positionsAddress,
        });
      } else {
        const locked = await this.withConditionLock(entryConditionId, async () => {
          return this.processEntryMarket({
            entryMarket,
            currentConditionId: context.currentConditionId,
            positionsAddress,
          });
        });

        if (!locked.executed) {
          this.logger.debug(
            { conditionId: entryConditionId },
            "Market task skipped entry condition: already in flight",
          );
          entryResult = {
            outcome: "recovery-needed",
            conditionId: entryConditionId,
            secondsToClose:
              context.currentConditionId === entryConditionId && context.currentMarket
                ? this.marketDiscovery.getSecondsToMarketClose(context.currentMarket)
                : null,
          };
        } else if (locked.result) {
          entryResult = locked.result;
        }
      }
    } else {
      this.logger.info("No market available for new entry");
    }

    return {
      outcome: this.combineMarketTaskOutcomes(currentResult, entryResult),
      hasTrackedExposure: currentResult.hasTrackedExposure || entryResult.outcome !== "idle",
      secondsToClose:
        currentResult.secondsToClose !== null ? currentResult.secondsToClose : entryResult.secondsToClose,
    };
  }

  private async runRedeemTask(positionsAddress: string): Promise<void> {
    try {
      await this.processRedeemablePositions(positionsAddress);
    } catch (error) {
      this.logger.error({ error }, "Redeem task error");
      await this.notifyOperationalIssue({
        title: "Redeem task error",
        severity: "error",
        dedupeKey: "task-error:redeem",
        error,
      });
    }
  }

  private async runTelegramTask(): Promise<void> {
    try {
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
              details: [
                { key: "error", value: error instanceof Error ? error.message : String(error) },
              ],
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn({ error }, "Telegram command task error");
      await this.notifyOperationalIssue({
        title: "Telegram command task error",
        severity: "warn",
        dedupeKey: "task-error:telegram-command",
        error,
      });
    }
  }

  async runForever(): Promise<void> {
    await this.clobClient.init();
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
        { key: "marketPollMs", value: this.config.marketPollMs },
        { key: "marketUrgentPollMs", value: this.config.marketUrgentPollMs },
        { key: "entryReconcileSec", value: this.config.entryReconcileSeconds },
        { key: "redeemEnabled", value: this.config.redeemEnabled ? "true" : "false" },
        { key: "redeemPollMs", value: this.config.redeemPollMs },
        { key: "telegramPollMs", value: this.config.telegramPollMs },
        { key: "redeemMaxRetries", value: this.config.redeemMaxRetries },
        { key: "wsEnabled", value: this.config.enableClobWs ? "true" : "false" },
        { key: "relayerEnabled", value: this.relayerClient.isAvailable() ? "true" : "false" },
        {
          key: "availableBuilders",
          value: this.relayerClient.getAvailableBuilderLabels().join(", ") || "none",
        },
      ],
    });

    await runScheduler(this.context, positionsAddress);

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
