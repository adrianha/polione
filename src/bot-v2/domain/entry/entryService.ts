import type { Logger } from "pino";
import type { BotConfig, MarketRecord } from "../../../types/domain.js";
import { MarketDiscoveryService } from "../../../services/marketDiscovery.js";
import { TradingEngine } from "../../../services/tradingEngine.js";
import { DataClient } from "../../../clients/dataClient.js";
import { PolyClobClient } from "../../../clients/clobClient.js";
import { summarizePositions } from "../../../services/positionManager.js";
import { NotificationService } from "../notification/notificationService.js";
import { TrackedMarketState } from "../state/trackedMarketState.js";

export class EntryService {
  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly marketDiscovery: MarketDiscoveryService,
    private readonly tradingEngine: TradingEngine,
    private readonly dataClient: DataClient,
    private readonly clobClient: PolyClobClient,
    private readonly trackedMarketState: TrackedMarketState,
    private readonly notifier: NotificationService,
  ) {}

  selectEntryMarket(params: {
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

  async processEntry(params: {
    entryMarket: MarketRecord;
    currentConditionId: string | null;
    positionsAddress: string;
  }): Promise<void> {
    const { entryMarket, currentConditionId, positionsAddress } = params;
    const entryTokenIds = this.marketDiscovery.getTokenIds(entryMarket);
    if (!entryTokenIds) {
      this.logger.warn({ slug: entryMarket.slug }, "Entry market found but no token IDs");
      await this.notifier.notifyOperationalIssue({
        title: "Entry market missing token IDs",
        severity: "warn",
        dedupeKey: `entry-market-missing-token-ids:v2:${entryMarket.slug}`,
        slug: entryMarket.slug,
      });
      return;
    }

    const entryConditionId = this.marketDiscovery.getConditionId(entryMarket);
    if (!entryConditionId) {
      this.logger.warn({ slug: entryMarket.slug }, "Entry market missing condition ID");
      await this.notifier.notifyOperationalIssue({
        title: "Entry market missing condition ID",
        severity: "warn",
        dedupeKey: `entry-market-missing-condition-id:v2:${entryMarket.slug}`,
        slug: entryMarket.slug,
      });
      return;
    }

    const existingPositions = await this.dataClient.getPositions(
      positionsAddress,
      entryConditionId,
    );
    const existingSummary = summarizePositions(existingPositions, entryTokenIds);
    if (existingSummary.upSize > 0 || existingSummary.downSize > 0) {
      this.logger.warn(
        {
          conditionId: entryConditionId,
          slug: entryMarket.slug,
          up: existingSummary.upSize,
          down: existingSummary.downSize,
          diff: existingSummary.differenceAbs,
        },
        "Skipped paired entry: existing exposure detected; handed off to tracked-market recovery",
      );
      await this.trackedMarketState.add(entryConditionId);
      return;
    }

    if (this.trackedMarketState.has(entryConditionId)) {
      this.logger.debug(
        { conditionId: entryConditionId, slug: entryMarket.slug },
        "Skipped new entry: market already tracked",
      );
      return;
    }

    const requiredUsdc = 5;
    const currentUsdcBalance = await this.clobClient.getUsdcBalance();
    if (currentUsdcBalance < requiredUsdc) {
      this.logger.debug(
        {
          conditionId: entryConditionId,
          slug: entryMarket.slug,
          usdcBalance: currentUsdcBalance,
          requiredUsdc,
        },
        "Skipped new entry: insufficient USDC balance",
      );
      return;
    }

    const isCurrentMarketEntry =
      currentConditionId !== null && entryConditionId === currentConditionId;
    const secondsToClose = isCurrentMarketEntry
      ? this.marketDiscovery.getSecondsToMarketClose(entryMarket)
      : null;
    const isInsideForceSellWindow =
      isCurrentMarketEntry &&
      secondsToClose !== null &&
      secondsToClose <= this.config.forceSellThresholdSeconds;

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
        secondsToClose,
        forceSellWindow: isInsideForceSellWindow,
      },
      "Placed paired limit buy orders",
    );

    await this.notifier.notifyPlacementSuccessOnce({
      conditionId: entryConditionId,
      slug: entryMarket.slug,
      upTokenId: entryTokenIds.upTokenId,
      downTokenId: entryTokenIds.downTokenId,
      entryPrice,
      orderSize: this.config.orderSize,
      mode: isCurrentMarketEntry ? "current-market" : "non-current-market",
      secondsToClose,
    });

    if (!isCurrentMarketEntry) {
      await this.trackedMarketState.add(entryConditionId);
      this.logger.info(
        {
          conditionId: entryConditionId,
          slug: entryMarket.slug,
        },
        "Deferred recovery for non-current market until it becomes current",
      );
      return;
    }

    const reconcile = await this.tradingEngine.reconcilePairedEntry({
      positionsAddress,
      conditionId: entryConditionId,
      tokenIds: entryTokenIds,
      cancelOpenOrders: !isInsideForceSellWindow,
    });

    if (reconcile.status === "balanced") {
      await this.tradingEngine.cancelEntryOpenOrders(entryTokenIds);
      await this.notifier.notifyEntryFilledOnce({
        conditionId: entryConditionId,
        slug: entryMarket.slug,
        upTokenId: entryTokenIds.upTokenId,
        downTokenId: entryTokenIds.downTokenId,
        upSize: reconcile.finalSummary.upSize,
        downSize: reconcile.finalSummary.downSize,
        entryPrice,
        mode: "reconcile",
      });
      await this.trackedMarketState.add(entryConditionId);
      this.logger.info(
        {
          conditionId: entryConditionId,
          status: reconcile.status,
          attempts: reconcile.attempts,
          summary: reconcile.finalSummary,
        },
        "Entry reconciliation succeeded",
      );
      return;
    }

    if (reconcile.status === "imbalanced") {
      try {
        await this.tradingEngine.cancelEntryOpenOrders(entryTokenIds);
      } catch (error) {
        this.logger.warn(
          {
            conditionId: entryConditionId,
            error,
            path: "entry-v2:imbalance-handoff-cancel",
          },
          "Failed to immediately cancel paired entry orders during recovery handoff",
        );
      }

      await this.trackedMarketState.add(entryConditionId);
      await this.notifier.notify({
        title: "Entry remains imbalanced",
        severity: "warn",
        dedupeKey: `reconcile-imbalanced:v2:${entryConditionId}`,
        slug: entryMarket.slug,
        conditionId: entryConditionId,
        upTokenId: entryTokenIds.upTokenId,
        downTokenId: entryTokenIds.downTokenId,
        details: [
          { key: "entryPrice", value: entryPrice },
          { key: "up", value: reconcile.finalSummary.upSize },
          { key: "down", value: reconcile.finalSummary.downSize },
          { key: "diff", value: reconcile.finalSummary.differenceAbs },
          { key: "reason", value: reconcile.reason },
          { key: "secondsToClose", value: secondsToClose },
        ],
      });
      return;
    }

    this.logger.error(
      {
        conditionId: entryConditionId,
        status: reconcile.status,
        attempts: reconcile.attempts,
        summary: reconcile.finalSummary,
        reason: reconcile.reason,
        entryPrice,
      },
      "Entry reconciliation failed",
    );
    await this.notifier.notify({
      title: "Entry reconciliation failed",
      severity: "error",
      dedupeKey: `reconcile-failed:v2:${entryConditionId}`,
      slug: entryMarket.slug,
      conditionId: entryConditionId,
      upTokenId: entryTokenIds.upTokenId,
      downTokenId: entryTokenIds.downTokenId,
      details: [
        { key: "entryPrice", value: entryPrice },
        { key: "up", value: reconcile.finalSummary.upSize },
        { key: "down", value: reconcile.finalSummary.downSize },
        { key: "diff", value: reconcile.finalSummary.differenceAbs },
        { key: "reason", value: reconcile.reason },
      ],
    });
  }
}
