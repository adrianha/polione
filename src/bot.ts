import type { Logger } from "pino";
import type { BotConfig, MarketRecord } from "./types/domain.js";
import { GammaClient } from "./clients/gammaClient.js";
import { PolyClobClient } from "./clients/clobClient.js";
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
  private readonly mergeAttemptedMarkets = new Set<string>();

  private readonly gammaClient: GammaClient;
  private readonly clobClient: PolyClobClient;
  private readonly relayerClient: PolyRelayerClient;
  private readonly dataClient: DataClient;
  private readonly marketDiscovery: MarketDiscoveryService;
  private readonly tradingEngine: TradingEngine;
  private readonly settlementService: SettlementService;
  private readonly stateStore: StateStore;
  private latestCurrentMarket: MarketRecord | null = null;
  private latestNextMarket: MarketRecord | null = null;

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
    this.stateStore = new StateStore(config.stateFilePath);
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
      this.mergeAttemptedMarkets.add(currentConditionId);
      const amount = Math.min(currentSummary.upSize, currentSummary.downSize);
      const merge = await this.settlementService.mergeEqualPositions(currentConditionId, amount);
      this.logger.info({ merge, conditionId: currentConditionId }, "Merge flow executed");
      return;
    }

    if (
      !positionsEqual &&
      secondsToClose !== null &&
      secondsToClose <= this.config.forceSellThresholdSeconds
    ) {
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
      await this.markEnteredMarket(entryConditionId);
      return this.config.loopSleepSeconds;
    }

    for (let attempt = 0; attempt <= this.config.entryMaxRepriceAttempts; attempt += 1) {
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
          },
          "Skipped entry attempt due to liquidity/spread gate",
        );
        return this.config.loopSleepSeconds;
      }

      const paired = await this.tradingEngine.placePairedLimitBuysAtPrice(entryTokenIds, entryPrice, liquidity.orderSize);
      this.logger.info(
        {
          paired,
          conditionId: entryConditionId,
          entryPrice,
          orderSize: liquidity.orderSize,
          attempt,
          maxAttempts: this.config.entryMaxRepriceAttempts,
          upSpread: liquidity.upSpread,
          downSpread: liquidity.downSpread,
          upDepth: liquidity.upDepth,
          downDepth: liquidity.downDepth,
        },
        "Placed paired limit buy orders",
      );

      const isFinalAttempt = attempt >= this.config.entryMaxRepriceAttempts;
      const reconcile = await this.tradingEngine.reconcilePairedEntry({
        positionsAddress,
        conditionId: entryConditionId,
        tokenIds: entryTokenIds,
        flattenOnImbalance: isFinalAttempt,
        cancelOpenOrders: true,
      });

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
        const currentMarket = this.latestCurrentMarket;
        if (!currentMarket) {
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const currentConditionId = this.marketDiscovery.getConditionId(currentMarket);
        if (currentConditionId && this.enteredMarkets.has(currentConditionId)) {
          await this.processCurrentEnteredMarket({
            currentMarket,
            currentConditionId,
            positionsAddress,
          });
        }
      } catch (error) {
        this.logger.error({ error }, "Current market loop error");
      }

      await sleep(this.config.loopSleepSeconds);
    }
  }

  private async entryLoop(positionsAddress: string): Promise<void> {
    while (!this.stopped) {
      let sleepSeconds = this.config.loopSleepSeconds;

      try {
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

        sleepSeconds = await this.processEntryMarket({
          entryMarket,
          currentConditionId,
          positionsAddress,
        });
      } catch (error) {
        this.logger.error({ error }, "Entry loop error");
      }

      await sleep(sleepSeconds);
    }
  }

  async runForever(): Promise<void> {
    await this.clobClient.init();
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
