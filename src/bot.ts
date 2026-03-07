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
import { sleep } from "./utils/time.js";

export class PolymarketBot {
  private stopped = false;

  private readonly gammaClient: GammaClient;
  private readonly clobClient: PolyClobClient;
  private readonly relayerClient: PolyRelayerClient;
  private readonly dataClient: DataClient;
  private readonly marketDiscovery: MarketDiscoveryService;
  private readonly tradingEngine: TradingEngine;
  private readonly settlementService: SettlementService;

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
  }

  stop(): void {
    this.stopped = true;
  }

  async runForever(): Promise<void> {
    await this.clobClient.init();
    const userAddress = await this.clobClient.getSignerAddress();

    this.logger.info(
      {
        dryRun: this.config.dryRun,
        liveTrading: this.config.enableLiveTrading,
        userAddress,
        relayerEnabled: this.relayerClient.isAvailable()
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

        const secondsToCloseForEntry = this.marketDiscovery.getSecondsToMarketClose(market);
        if (
          secondsToCloseForEntry !== null &&
          secondsToCloseForEntry <= this.config.minSecondsToCloseForEntry
        ) {
          this.logger.warn(
            {
              secondsToClose: secondsToCloseForEntry,
              minRequired: this.config.minSecondsToCloseForEntry,
              slug: market.slug
            },
            "Skipped entry: market too close to end time"
          );
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const ev = await this.tradingEngine.evaluateEntry(tokenIds);
        this.logger.info({ ev }, "EV evaluation");
        if (!ev.allowed) {
          this.logger.warn(
            {
              netPerShare: ev.netPerShare,
              minRequiredPerShare: ev.minRequiredPerShare,
              grossEdgePerShare: ev.grossEdgePerShare,
              totalCostsPerShare: ev.totalCostsPerShare
            },
            "EV guard blocked order placement"
          );
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const conditionId = this.marketDiscovery.getConditionId(market);
        if (!conditionId) {
          this.logger.warn("Market missing condition ID; skipping settlement checks");
          await sleep(this.config.loopSleepSeconds);
          continue;
        }

        const preEntryPositions = await this.dataClient.getPositions(userAddress, conditionId);
        const preEntrySummary = summarizePositions(preEntryPositions, tokenIds);
        const hasOpenExposure = preEntrySummary.upSize > 0 || preEntrySummary.downSize > 0;
        const preEntryEqual = arePositionsEqual(preEntrySummary, this.config.positionEqualityTolerance);
        if (hasOpenExposure && !preEntryEqual) {
          const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(market);
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

          if (secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
            const forceSell = await this.tradingEngine.forceSellAll(preEntrySummary, tokenIds);
            this.logger.info({ forceSell }, "Force sell flow executed from pre-entry imbalance check");
          }

          await sleep(this.config.positionRecheckSeconds);
          continue;
        }

        const paired = await this.tradingEngine.placePairedLimitBuys(tokenIds);
        this.logger.info({ paired }, "Placed paired limit buy orders");

        const positions = await this.dataClient.getPositions(userAddress, conditionId);
        const summary = summarizePositions(positions, tokenIds);
        const equal = arePositionsEqual(summary, this.config.positionEqualityTolerance);
        const secondsToClose = this.marketDiscovery.getSecondsToMarketClose(market);

        this.logger.info(
          {
            conditionId,
            up: summary.upSize,
            down: summary.downSize,
            diff: summary.differenceAbs,
            equal,
            secondsToClose
          },
          "Position check"
        );

        if (equal && summary.upSize > 0 && this.relayerClient.isAvailable()) {
          const amount = Math.min(summary.upSize, summary.downSize);
          const merge = await this.settlementService.mergeEqualPositions(conditionId, amount);
          this.logger.info({ merge }, "Merge flow executed");
        } else if (!equal && secondsToClose !== null && secondsToClose <= this.config.forceSellThresholdSeconds) {
          const forceSell = await this.tradingEngine.forceSellAll(summary, tokenIds);
          this.logger.info({ forceSell }, "Force sell flow executed");
        }

        await sleep(this.config.positionRecheckSeconds);
      } catch (error) {
        this.logger.error({ error }, "Main loop error");
        await sleep(this.config.loopSleepSeconds);
      }
    }

    this.logger.info("Bot stopped");
  }
}
