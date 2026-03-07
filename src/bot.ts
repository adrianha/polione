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
    private readonly logger: Logger
  ) {
    this.gammaClient = new GammaClient(config);
    this.clobClient = new PolyClobClient(config);
    this.relayerClient = new PolyRelayerClient(config);
    this.dataClient = new DataClient(config);
    this.marketDiscovery = new MarketDiscoveryService(config, this.gammaClient);
    this.tradingEngine = new TradingEngine(config, this.clobClient);
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
          conditionId
        },
        "Failed to persist entered market state"
      );
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async runForever(): Promise<void> {
    await this.clobClient.init();
    const userAddress = await this.clobClient.getSignerAddress();
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
          stateFilePath: this.config.stateFilePath
        },
        "Failed to load persisted entered market state"
      );
    }

    this.logger.info(
      {
        dryRun: this.config.dryRun,
        userAddress,
        positionsAddress,
        relayerEnabled: this.relayerClient.isAvailable(),
        persistedEnteredMarketCount: this.enteredMarkets.size,
        stateFilePath: this.config.stateFilePath
      },
      "Bot initialized"
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

        const currentConditionId = currentMarket
          ? this.marketDiscovery.getConditionId(currentMarket)
          : null;

        if (currentMarket && currentConditionId && this.enteredMarkets.has(currentConditionId)) {
          const currentTokenIds = this.marketDiscovery.getTokenIds(currentMarket);
          if (!currentTokenIds) {
            this.logger.warn(
              { slug: currentMarket.slug, conditionId: currentConditionId },
              "Current entered market missing token IDs"
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
                secondsToClose
              },
              "Position check"
            );

            if (positionsEqual && currentSummary.upSize > 0 && this.relayerClient.isAvailable()) {
              const amount = Math.min(currentSummary.upSize, currentSummary.downSize);
              const merge = await this.settlementService.mergeEqualPositions(currentConditionId, amount);
              this.logger.info({ merge, conditionId: currentConditionId }, "Merge flow executed");
            } else if (!positionsEqual && secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
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
            downTokenId: entryTokenIds.downTokenId
          },
          "Evaluating entry market"
        );

        if (this.enteredMarkets.has(entryConditionId)) {
          this.logger.info(
            {
              conditionId: entryConditionId,
              slug: entryMarket.slug
            },
            "Skipped new entry: market already has one paired entry"
          );
          await sleep(this.config.positionRecheckSeconds);
          continue;
        }

        const entryPositions = await this.dataClient.getPositions(positionsAddress, entryConditionId);
        const entrySummary = summarizePositions(entryPositions, entryTokenIds);
        const entryHasOpenExposure = entrySummary.upSize > 0 || entrySummary.downSize > 0;
        const entryEqual = arePositionsEqual(entrySummary, this.config.positionEqualityTolerance);
        const entrySecondsToClose = this.marketDiscovery.getSecondsToMarketClose(entryMarket);

        if (entryHasOpenExposure) {
          this.logger.warn(
            {
              conditionId: entryConditionId,
              slug: entryMarket.slug,
              up: entrySummary.upSize,
              down: entrySummary.downSize,
              diff: entrySummary.differenceAbs,
              equal: entryEqual,
              secondsToClose: entrySecondsToClose
            },
            "Skipped new entry: existing position exposure detected"
          );

          if (!entryEqual && entrySecondsToClose !== null && entrySecondsToClose <= this.config.forceSellThresholdSeconds) {
            const forceSell = await this.tradingEngine.forceSellAll(entrySummary, entryTokenIds);
            this.logger.info({ forceSell, conditionId: entryConditionId }, "Force sell flow executed from entry guard");
          }

          await sleep(this.config.positionRecheckSeconds);
          continue;
        }

        const paired = await this.tradingEngine.placePairedLimitBuys(entryTokenIds);
        await this.markEnteredMarket(entryConditionId);
        this.logger.info({ paired, conditionId: entryConditionId }, "Placed paired limit buy orders");

        await sleep(this.config.positionRecheckSeconds);
      } catch (error) {
        this.logger.error({ error }, "Main loop error");
        await sleep(this.config.loopSleepSeconds);
      }
    }

    this.logger.info("Bot stopped");
  }
}
