import type { Logger } from "pino";
import type { BotConfig } from "./types/domain.js";
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

  async runForever(): Promise<void> {
    await this.clobClient.init();
    const userAddress = this.clobClient.getSignerAddress();
    const positionsAddress = this.config.funder ?? userAddress;

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

    while (!this.stopped) {
      try {
        const currentMarket = await this.marketDiscovery.findCurrentActiveMarket();
        const nextMarket = await this.marketDiscovery.findNextActiveMarket();

        if (!currentMarket && !nextMarket) {
          this.logger.warn("No active market found, retrying");
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const currentConditionId = currentMarket ? this.marketDiscovery.getConditionId(currentMarket) : null;

        if (currentMarket && currentConditionId && this.enteredMarkets.has(currentConditionId)) {
          const currentTokenIds = this.marketDiscovery.getTokenIds(currentMarket);
          if (!currentTokenIds) {
            this.logger.warn(
              { slug: currentMarket.slug, conditionId: currentConditionId },
              "Current entered market missing token IDs",
            );
          } else {
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
            } else if (
              !positionsEqual &&
              secondsToClose !== null &&
              secondsToClose <= this.config.forceSellThresholdSeconds
            ) {
              const forceSell = await this.tradingEngine.forceSellAll(currentSummary, currentTokenIds);
              this.logger.info({ forceSell, conditionId: currentConditionId }, "Force sell flow executed");
            }
          }
        }

        let entryMarket = nextMarket;
        if (entryMarket && currentConditionId) {
          const entryConditionId = this.marketDiscovery.getConditionId(entryMarket);
          if (entryConditionId === currentConditionId) {
            entryMarket = null;
          }
        }

        if (!entryMarket) {
          this.logger.info("No distinct next market available for new entry");
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const entryTokenIds = this.marketDiscovery.getTokenIds(entryMarket);
        if (!entryTokenIds) {
          this.logger.warn({ slug: entryMarket.slug }, "Entry market found but no token IDs");
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const entryConditionId = this.marketDiscovery.getConditionId(entryMarket);
        if (!entryConditionId) {
          this.logger.warn({ slug: entryMarket.slug }, "Entry market missing condition ID");
          await sleep(this.config.loopSleepSeconds);
          continue;
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
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const requiredUsdcForBothLegs = this.config.orderPrice * this.config.orderSize * 2;
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
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const paired = await this.tradingEngine.placePairedLimitBuys(entryTokenIds);
        this.logger.info({ paired, conditionId: entryConditionId }, "Placed paired limit buy orders");

        const reconcile = await this.tradingEngine.reconcilePairedEntry({
          positionsAddress,
          conditionId: entryConditionId,
          tokenIds: entryTokenIds,
        });

        if (reconcile.status === "balanced") {
          await this.markEnteredMarket(entryConditionId);
          this.logger.info(
            {
              conditionId: entryConditionId,
              status: reconcile.status,
              attempts: reconcile.attempts,
              summary: reconcile.finalSummary,
            },
            "Entry reconciliation succeeded",
          );
          await sleep(this.config.positionRecheckSeconds);
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
            },
            "Entry reconciliation flattened imbalanced exposure",
          );
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        this.logger.error(
          {
            conditionId: entryConditionId,
            status: reconcile.status,
            attempts: reconcile.attempts,
            summary: reconcile.finalSummary,
            cancelledOpenOrders: reconcile.cancelledOpenOrders,
            reason: reconcile.reason,
          },
          "Entry reconciliation failed",
        );

        await sleep(this.config.loopSleepSeconds);
        continue;
      } catch (error) {
        this.logger.error({ error }, "Main loop error");
        await sleep(this.config.loopSleepSeconds);
      }
    }

    this.logger.info("Bot stopped");
  }
}
