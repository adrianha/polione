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
        relayerEnabled: this.relayerClient.isAvailable(),
        persistedEnteredMarketCount: this.enteredMarkets.size,
        stateFilePath: this.config.stateFilePath
      },
      "Bot initialized"
    );

    while (!this.stopped) {
      try {
        const market = await this.marketDiscovery.findNextActiveMarket();
        if (!market) {
          this.logger.warn("No active market found, retrying");
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const tokenIds = this.marketDiscovery.getTokenIds(market);
        if (!tokenIds) {
          this.logger.warn({ slug: market.slug }, "Market found but no token IDs");
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        this.logger.info(
          {
            slug: market.slug,
            upTokenId: tokenIds.upTokenId,
            downTokenId: tokenIds.downTokenId
          },
          "Processing market"
        );

        const conditionId = this.marketDiscovery.getConditionId(market);
        if (!conditionId) {
          this.logger.warn("Market missing condition ID; skipping settlement checks");
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const alreadyEnteredCurrentMarket = this.enteredMarkets.has(conditionId);
        const preEntryPositions = await this.dataClient.getPositions(userAddress, conditionId);
        const preEntrySummary = summarizePositions(preEntryPositions, tokenIds);
        const hasOpenExposure = preEntrySummary.upSize > 0 || preEntrySummary.downSize > 0;
        const preEntryEqual = arePositionsEqual(preEntrySummary, this.config.positionEqualityTolerance);
        const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(market);

        this.logger.info(
          {
            conditionId,
            up: preEntrySummary.upSize,
            down: preEntrySummary.downSize,
            diff: preEntrySummary.differenceAbs,
            equal: preEntryEqual,
            secondsToClose
          },
          "Position check"
        );

        let settlementActionTaken = false;
        if (preEntryEqual && preEntrySummary.upSize > 0 && this.relayerClient.isAvailable()) {
          const amount = Math.min(preEntrySummary.upSize, preEntrySummary.downSize);
          const merge = await this.settlementService.mergeEqualPositions(conditionId, amount);
          settlementActionTaken = true;
          this.logger.info({ merge }, "Merge flow executed");
        } else if (!preEntryEqual && secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
          const forceSell = await this.tradingEngine.forceSellAll(preEntrySummary, tokenIds);
          settlementActionTaken = true;
          this.logger.info({ forceSell }, "Force sell flow executed");
        }

        if (alreadyEnteredCurrentMarket) {
          this.logger.info(
            {
              conditionId,
              slug: market.slug
            },
            "Skipped new entry: market already has one paired entry"
          );
          await sleep(this.config.positionRecheckSeconds);
          continue;
        }

        if (hasOpenExposure && !preEntryEqual) {
          this.logger.warn(
            {
              conditionId,
              up: preEntrySummary.upSize,
              down: preEntrySummary.downSize,
              diff: preEntrySummary.differenceAbs,
              secondsToClose
            },
            "Skipped new entry: existing position imbalance detected"
          );

          if (!settlementActionTaken && secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
            const forceSell = await this.tradingEngine.forceSellAll(preEntrySummary, tokenIds);
            this.logger.info({ forceSell }, "Force sell flow executed from pre-entry imbalance check");
          }

          await sleep(this.config.positionRecheckSeconds);
          continue;
        }

        const paired = await this.tradingEngine.placePairedLimitBuys(tokenIds);
        await this.markEnteredMarket(conditionId);
        this.logger.info({ paired }, "Placed paired limit buy orders");

        await sleep(this.config.positionRecheckSeconds);
      } catch (error) {
        this.logger.error({ error }, "Main loop error");
        await sleep(this.config.loopSleepSeconds);
      }
    }

    this.logger.info("Bot stopped");
  }
}
