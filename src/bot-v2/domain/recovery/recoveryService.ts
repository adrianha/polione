import type { Logger } from "pino";
import type { BotConfig, MarketRecord, PositionSummary, TokenIds } from "../../../types/domain.js";
import { DataClient } from "../../../clients/dataClient.js";
import { MarketDiscoveryService } from "../../../services/marketDiscovery.js";
import { MarketTokenMismatchError, TradingEngine } from "../../../services/tradingEngine.js";
import { arePositionsEqual, summarizePositions } from "../../../services/positionManager.js";
import { NotificationService } from "../notification/notificationService.js";
import { MergeService } from "../settlement/mergeService.js";

const MIN_MARKET_MAKER_ORDER_SIZE = 5;

export class RecoveryService {
  private readonly balancedOrderCleanupDone = new Set<string>();
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

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly marketDiscovery: MarketDiscoveryService,
    private readonly tradingEngine: TradingEngine,
    private readonly dataClient: DataClient,
    private readonly notifier: NotificationService,
    private readonly mergeService: MergeService,
  ) {}

  private roundPrice(price: number): number {
    return Number(price.toFixed(4));
  }

  private getImbalancePlan(
    summary: PositionSummary,
    tokenIds: TokenIds,
  ): {
    missingLegTokenId: string;
    missingAmount: number;
  } | null {
    if (summary.upSize > summary.downSize) {
      const missingAmount = Number((summary.upSize - summary.downSize).toFixed(6));
      if (missingAmount <= 0) {
        return null;
      }
      return {
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
        missingLegTokenId: tokenIds.upTokenId,
        missingAmount,
      };
    }

    return null;
  }

  private getConditionBuyCapacity(summary: PositionSummary): {
    reachedCap: boolean;
    remainingUp: number;
    remainingDown: number;
  } {
    const cap = Math.max(0, this.config.orderSize);
    const upSize = Math.max(0, summary.upSize);
    const downSize = Math.max(0, summary.downSize);
    const reachedCap =
      cap - upSize <= this.config.positionEqualityTolerance &&
      cap - downSize <= this.config.positionEqualityTolerance;

    return {
      reachedCap,
      remainingUp: Number(Math.max(0, cap - upSize).toFixed(6)),
      remainingDown: Number(Math.max(0, cap - downSize).toFixed(6)),
    };
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
  }): number {
    const bestBid = Math.max(0, params.bestBid);
    const bestAsk = Math.max(0, params.bestAsk);
    const maxMissingPrice = Math.max(0, params.maxMissingPrice);
    const makerOffset = Math.max(0, this.config.entryContinuousMakerOffset);
    if (maxMissingPrice <= 0 || bestBid <= 0 || bestAsk <= 0) {
      return 0;
    }

    const makerCandidate = bestBid + makerOffset;
    const nonCrossingCap = Math.max(0, bestAsk - makerOffset);
    const bounded = Math.min(maxMissingPrice, makerCandidate, nonCrossingCap);
    return this.roundPrice(bounded);
  }

  private evaluateForceWindowHedge(
    entryPrice: number,
    bestMissingAsk: number,
  ): {
    isProfitable: boolean;
    maxHedgePrice: number;
  } {
    const maxHedgePrice =
      1 - entryPrice - this.config.forceWindowFeeBuffer - this.config.forceWindowMinProfitPerShare;
    const expectedLockPnlPerShare =
      1 - entryPrice - bestMissingAsk - this.config.forceWindowFeeBuffer;
    return {
      isProfitable: expectedLockPnlPerShare >= this.config.forceWindowMinProfitPerShare,
      maxHedgePrice,
    };
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
      await this.notifier.notifyOperationalIssue({
        title: "Failed to cancel residual entry orders",
        severity: "warn",
        dedupeKey: `cancel-after-balance-failed:v2:${context.path}:${context.conditionId}`,
        conditionId: context.conditionId,
        upTokenId: tokenIds.upTokenId,
        downTokenId: tokenIds.downTokenId,
        error,
        details: [{ key: "path", value: context.path }],
      });
      return false;
    }
  }

  private async handleForceWindowImbalance(params: {
    market: MarketRecord;
    conditionId: string;
    positionsAddress: string;
    tokenIds: TokenIds;
    summary: PositionSummary;
    entryPrice: number;
  }): Promise<void> {
    const { market, conditionId, positionsAddress, tokenIds, summary, entryPrice } = params;
    const buyCapacity = this.getConditionBuyCapacity(summary);
    const missingLegTokenId =
      summary.upSize > summary.downSize ? tokenIds.downTokenId : tokenIds.upTokenId;
    const remainingForMissingLeg = this.getRemainingAllowanceForTokenId(
      missingLegTokenId,
      tokenIds,
      buyCapacity,
    );

    if (remainingForMissingLeg <= this.config.positionEqualityTolerance) {
      await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
      return;
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
        await this.notifier.notifyOperationalIssue({
          title: "Skipped force-window hedge (market mismatch)",
          severity: "warn",
          dedupeKey: `market-token-mismatch:v2:force-window:${conditionId}:${missingLegTokenId}`,
          slug: market.slug,
          conditionId,
          upTokenId: tokenIds.upTokenId,
          downTokenId: tokenIds.downTokenId,
          details: [{ key: "tokenId", value: missingLegTokenId }],
        });
        return;
      }
      throw error;
    }

    if (!Number.isFinite(bestMissingAsk) || bestMissingAsk <= 0) {
      await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
      return;
    }

    const hedge = this.evaluateForceWindowHedge(entryPrice, bestMissingAsk);
    if (!hedge.isProfitable) {
      await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
      return;
    }

    await this.tradingEngine.cancelEntryOpenOrders(tokenIds);
    await this.tradingEngine.completeMissingLegForHedge(summary, tokenIds, hedge.maxHedgePrice);
    await this.tradingEngine.reconcilePairedEntry({
      positionsAddress,
      conditionId,
      tokenIds,
      cancelOpenOrders: true,
    });
  }

  private async runContinuousMissingLegRecovery(params: {
    market: MarketRecord;
    conditionId: string;
    tokenIds: TokenIds;
    currentSummary: PositionSummary;
    filledLegAvgPrice: number;
  }): Promise<void> {
    const imbalance = this.getImbalancePlan(params.currentSummary, params.tokenIds);
    if (!imbalance || !this.config.entryContinuousRepriceEnabled) {
      return;
    }

    const buyCapacity = this.getConditionBuyCapacity(params.currentSummary);
    if (buyCapacity.reachedCap) {
      return;
    }

    const maxMissingPrice = this.roundPrice(
      1 -
        params.filledLegAvgPrice -
        this.config.forceWindowFeeBuffer -
        this.config.forceWindowMinProfitPerShare,
    );
    if (maxMissingPrice <= 0) {
      return;
    }

    let top: {
      bestBid: number;
      bestAsk: number;
      priceSource: "sdk";
      sdkBestBid: number;
      sdkBestAsk: number;
    };

    try {
      top = await this.tradingEngine.getTopOfBookForCondition({
        conditionId: params.conditionId,
        tokenIds: params.tokenIds,
        tokenId: imbalance.missingLegTokenId,
      });
    } catch (error) {
      if (error instanceof MarketTokenMismatchError) {
        await this.notifier.notifyOperationalIssue({
          title: "Skipped missing-leg recovery (market mismatch)",
          severity: "warn",
          dedupeKey: `market-token-mismatch:v2:recovery:${params.conditionId}:${imbalance.missingLegTokenId}`,
          slug: params.market.slug,
          conditionId: params.conditionId,
          upTokenId: params.tokenIds.upTokenId,
          downTokenId: params.tokenIds.downTokenId,
          details: [{ key: "tokenId", value: imbalance.missingLegTokenId }],
        });
        return;
      }
      throw error;
    }

    const makerPrice = this.computeMakerMissingLegPrice({
      bestBid: top.bestBid,
      bestAsk: top.bestAsk,
      maxMissingPrice,
    });
    const canCrossBestAsk = top.bestAsk > 0 && top.bestAsk <= maxMissingPrice;
    const finalPrice = canCrossBestAsk ? this.roundPrice(top.bestAsk) : makerPrice;
    if (finalPrice <= 0) {
      return;
    }

    const previousPlacement = this.recentRecoveryPlacements.get(params.conditionId);
    if (
      previousPlacement &&
      previousPlacement.missingLegTokenId === imbalance.missingLegTokenId &&
      Math.abs(finalPrice - previousPlacement.price) < Math.max(1e-6, this.config.entryContinuousMinPriceDelta)
    ) {
      return;
    }

    const hasSamePriceOpenRecoveryOrder = await this.tradingEngine.hasOpenBuyOrderAtPrice(
      imbalance.missingLegTokenId,
      finalPrice,
    );
    if (hasSamePriceOpenRecoveryOrder) {
      return;
    }

    await this.tradingEngine.cancelEntryOpenOrders(params.tokenIds);

    const remainingForMissingLeg = this.getRemainingAllowanceForTokenId(
      imbalance.missingLegTokenId,
      params.tokenIds,
      buyCapacity,
    );
    const cappedMissingAmount = Number(
      Math.min(imbalance.missingAmount, remainingForMissingLeg).toFixed(6),
    );
    if (cappedMissingAmount < MIN_MARKET_MAKER_ORDER_SIZE) {
      return;
    }

    const orderResult = await this.tradingEngine.placeSingleLimitBuyAtPrice(
      imbalance.missingLegTokenId,
      finalPrice,
      cappedMissingAmount,
    );
    const orderId = this.tradingEngine.extractOrderId(orderResult);

    this.recentRecoveryPlacements.set(params.conditionId, {
      placedAtMs: Date.now(),
      summary: params.currentSummary,
      missingLegTokenId: imbalance.missingLegTokenId,
      price: finalPrice,
      placedSize: cappedMissingAmount,
      orderId,
    });
  }

  async processTrackedCurrentMarket(params: {
    currentMarket: MarketRecord;
    currentConditionId: string;
    positionsAddress: string;
    relayerAvailable: boolean;
  }): Promise<void> {
    const { currentMarket, currentConditionId, positionsAddress, relayerAvailable } = params;
    const currentTokenIds = this.marketDiscovery.getTokenIds(currentMarket);
    if (!currentTokenIds) {
      await this.notifier.notifyOperationalIssue({
        title: "Tracked current market missing token IDs",
        severity: "warn",
        dedupeKey: `tracked-market-missing-token-ids:v2:${currentConditionId}`,
        slug: currentMarket.slug,
        conditionId: currentConditionId,
      });
      return;
    }

    const currentPositions = await this.dataClient.getPositions(positionsAddress, currentConditionId);
    const currentSummary = summarizePositions(currentPositions, currentTokenIds);
    const positionsEqual = arePositionsEqual(currentSummary, this.config.positionEqualityTolerance);
    const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(currentMarket);

    if (
      positionsEqual &&
      currentSummary.upSize > 0 &&
      !this.balancedOrderCleanupDone.has(currentConditionId)
    ) {
      const cleanupOk = await this.cancelEntryOrdersAfterBalance(currentTokenIds, {
        conditionId: currentConditionId,
        path: "tracked-market:v2:balanced-cleanup",
      });
      if (cleanupOk) {
        this.balancedOrderCleanupDone.add(currentConditionId);
      }
    }

    if (positionsEqual && currentSummary.upSize > 0) {
      await this.mergeService.tryMergeWhenBalanced({
        conditionId: currentConditionId,
        slug: currentMarket.slug,
        tokenIds: currentTokenIds,
        upSize: currentSummary.upSize,
        downSize: currentSummary.downSize,
        relayerAvailable,
      });
      return;
    }

    this.balancedOrderCleanupDone.delete(currentConditionId);

    if (
      secondsToClose !== null &&
      secondsToClose <= this.config.forceSellThresholdSeconds &&
      !positionsEqual
    ) {
      await this.handleForceWindowImbalance({
        market: currentMarket,
        conditionId: currentConditionId,
        positionsAddress,
        tokenIds: currentTokenIds,
        summary: currentSummary,
        entryPrice: this.config.orderPrice,
      });
      return;
    }

    if (!positionsEqual) {
      await this.runContinuousMissingLegRecovery({
        market: currentMarket,
        conditionId: currentConditionId,
        tokenIds: currentTokenIds,
        currentSummary,
        filledLegAvgPrice: this.config.orderPrice,
      });
    }
  }
}
