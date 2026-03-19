import type { Logger } from "pino";
import type { BotConfig } from "../types/domain.js";
import { GammaClient } from "../clients/gammaClient.js";
import { PolyClobClient } from "../clients/clobClient.js";
import { PolyRelayerClient } from "../clients/relayerClient.js";
import { DataClient } from "../clients/dataClient.js";
import { RedeemPrecheckService } from "../services/redeemPrecheck.js";
import { TelegramClient } from "../clients/telegramClient.js";
import { sleep } from "../utils/time.js";
import { createV3Config } from "./config.js";
import { V3PositionStore } from "./state/positionStore.js";
import { V3LockService } from "./runtime/lockService.js";
import { V3MarketService } from "./services/marketService.js";
import { V3SignalService } from "./services/signalService.js";
import { V3PortfolioService } from "./services/portfolioService.js";
import { V3ExecutionService } from "./services/executionService.js";
import { V3ResolutionService } from "./services/resolutionService.js";
import { V3NotificationService } from "./services/notificationService.js";
import type { V3Config, V3LivePosition } from "./types.js";

export class PolymarketBotV3 {
  private stopped = false;
  private readonly v3Config: V3Config;
  private readonly gammaClient: GammaClient;
  private readonly clobClient: PolyClobClient;
  private readonly relayerClient: PolyRelayerClient;
  private readonly dataClient: DataClient;
  private readonly redeemPrecheck: RedeemPrecheckService;
  private readonly telegramClient: TelegramClient;
  private readonly positionStore: V3PositionStore;
  private readonly lockService = new V3LockService();
  private readonly marketService: V3MarketService;
  private readonly signalService: V3SignalService;
  private readonly portfolioService: V3PortfolioService;
  private readonly executionService: V3ExecutionService;
  private readonly resolutionService: V3ResolutionService;
  private readonly notificationService: V3NotificationService;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {
    this.v3Config = createV3Config(config);
    this.gammaClient = new GammaClient(config);
    this.clobClient = new PolyClobClient(config);
    this.relayerClient = new PolyRelayerClient(config);
    this.dataClient = new DataClient(config);
    this.redeemPrecheck = new RedeemPrecheckService(config);
    this.telegramClient = new TelegramClient({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
      logger,
    });
    this.positionStore = new V3PositionStore(this.v3Config.stateFilePath);
    this.marketService = new V3MarketService(
      this.v3Config,
      this.gammaClient,
      this.clobClient,
      this.logger,
    );
    this.signalService = new V3SignalService(this.v3Config);
    this.portfolioService = new V3PortfolioService(
      this.v3Config,
      this.dataClient,
      this.positionStore,
      this.logger,
    );
    this.executionService = new V3ExecutionService(this.v3Config, this.clobClient);
    this.resolutionService = new V3ResolutionService(
      this.v3Config,
      this.dataClient,
      this.relayerClient,
      this.redeemPrecheck,
      this.marketService,
      this.logger,
    );
    this.notificationService = new V3NotificationService(this.telegramClient);
  }

  stop(): void {
    this.stopped = true;
  }

  async runForever(): Promise<void> {
    await this.clobClient.init();
    const userAddress = this.clobClient.getSignerAddress();
    const positionsAddress = this.config.funder ?? userAddress;
    await this.portfolioService.load();

    this.logger.info(
      {
        dryRun: this.config.dryRun,
        runtime: "v3",
        userAddress,
        positionsAddress,
        marketSlugPrefix: this.v3Config.marketSlugPrefix,
        entryThreshold: this.v3Config.entryThreshold,
        takeProfitPrice: this.v3Config.takeProfitPrice,
        stopLossPrice: this.v3Config.stopLossPrice,
        maxExecutionValue: this.v3Config.maxExecutionValue,
        stateFilePath: this.v3Config.stateFilePath,
      },
      "Bot V3 initialized",
    );

    while (!this.stopped) {
      try {
        await this.tick(positionsAddress);
      } catch (error) {
        this.logger.error({ error }, "Bot V3 tick failed");
      }

      if (!this.stopped) {
        await sleep(this.v3Config.loopIntervalSeconds);
      }
    }

    this.logger.info("Bot V3 stopped");
  }

  private async tick(positionsAddress: string): Promise<void> {
    const livePosition = this.portfolioService.getLivePosition();
    if (livePosition) {
      await this.manageLivePosition(livePosition, positionsAddress);
      return;
    }

    const hasCapacity = await this.portfolioService.hasCapacityForNewPosition(positionsAddress);
    if (!hasCapacity) {
      return;
    }

    const snapshot = await this.marketService.getCurrentMarketSnapshot();
    if (!snapshot) {
      return;
    }

    const signal = this.signalService.evaluate(snapshot);
    if (!signal) {
      return;
    }

    const usdcBalance = await this.clobClient.getUsdcBalance();
    const entrySize = this.getExecutionSize(signal.bestAsk);
    if (entrySize <= 0) {
      this.logger.debug(
        { bestAsk: signal.bestAsk, maxExecutionValue: this.v3Config.maxExecutionValue, slug: signal.slug },
        "V3 entry skipped: execution size rounded to zero under max execution value",
      );
      return;
    }

    const requiredBalance = signal.bestAsk * entrySize;
    if (usdcBalance < requiredBalance) {
      this.logger.debug(
        { usdcBalance, requiredBalance, entrySize, slug: signal.slug },
        "V3 entry skipped: insufficient USDC balance",
      );
      return;
    }

    const existingConditionExposure = await this.portfolioService.hasAnyConditionExposure(
      positionsAddress,
      signal.conditionId,
    );
    if (existingConditionExposure) {
      this.logger.debug(
        { conditionId: signal.conditionId, slug: signal.slug },
        "V3 entry skipped: existing condition exposure detected",
      );
      return;
    }

    const locked = await this.lockService.withLock(`entry:${signal.conditionId}`, async () => {
      const fill = await this.executionService.buyToken({
        tokenId: signal.tokenId,
        size: entrySize,
      });
      if (fill.filledSize <= 0) {
        this.logger.info({ signal }, "V3 entry order did not fill");
        return;
      }

      const position: V3LivePosition = {
        conditionId: signal.conditionId,
        slug: signal.slug,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        entryPrice: fill.averagePrice,
        targetPrice: this.v3Config.takeProfitPrice,
        stopPrice: this.v3Config.stopLossPrice,
        status: "open",
        openedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };
      await this.portfolioService.saveLivePosition(position);
      await this.notificationService.notifyBuy({
        conditionId: signal.conditionId,
        slug: signal.slug,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        entryPrice: fill.averagePrice,
        filledSize: fill.filledSize,
        takeProfitPrice: this.v3Config.takeProfitPrice,
        stopLossPrice: this.v3Config.stopLossPrice,
      });
      this.logger.info(
        {
          slug: signal.slug,
          conditionId: signal.conditionId,
          tokenId: signal.tokenId,
          outcome: signal.outcome,
          entryPrice: fill.averagePrice,
          filledSize: fill.filledSize,
        },
        "V3 position opened",
      );
    });

    if (!locked.executed) {
      this.logger.debug({ conditionId: signal.conditionId }, "V3 entry skipped: lock already held");
    }
  }

  private async manageLivePosition(
    livePosition: V3LivePosition,
    positionsAddress: string,
  ): Promise<void> {
    const lockKey = `position:${livePosition.conditionId}`;
    const locked = await this.lockService.withLock(lockKey, async () => {
      if (livePosition.status === "awaiting_resolution" || livePosition.status === "redeeming") {
        await this.handleResolution(livePosition, positionsAddress);
        return;
      }

      const balanceState = await this.portfolioService.getTokenBalanceState(
        positionsAddress,
        livePosition.conditionId,
        livePosition.tokenId,
      );
      if (balanceState.heldSize <= 0.0001) {
        await this.portfolioService.clearLivePosition();
        this.logger.info(
          { conditionId: livePosition.conditionId },
          "V3 live position cleared because no token balance remains",
        );
        return;
      }

      const snapshot = await this.marketService.getMarketSnapshotBySlug(livePosition.slug);
      if (!snapshot) {
        return;
      }

      if (snapshot.secondsToClose !== null && snapshot.secondsToClose <= 0) {
        await this.portfolioService.saveLivePosition({
          ...livePosition,
          status: "awaiting_resolution",
          updatedAtMs: Date.now(),
        });
        return;
      }

      const tokenQuote = snapshot.tokens.find((token) => token.tokenId === livePosition.tokenId);
      if (!tokenQuote) {
        return;
      }

      const exitReason =
        tokenQuote.bestBid >= livePosition.targetPrice
          ? "tp"
          : tokenQuote.bestBid > 0 && tokenQuote.bestBid <= livePosition.stopPrice
            ? "sl"
            : null;
      if (!exitReason) {
        return;
      }

      const exitFill = await this.executionService.sellToken({
        tokenId: livePosition.tokenId,
        size: Math.min(balanceState.heldSize, this.getExecutionSize(tokenQuote.bestBid || livePosition.entryPrice)),
      });
      if (exitFill.filledSize <= 0) {
        this.logger.info(
          { conditionId: livePosition.conditionId, reason: exitReason },
          "V3 exit triggered but no shares sold",
        );
        return;
      }

      const remainingSize = Number(Math.max(0, balanceState.heldSize - exitFill.filledSize).toFixed(6));
      if (remainingSize <= 0.0001) {
        await this.notificationService.notifyExit({
          conditionId: livePosition.conditionId,
          slug: livePosition.slug,
          tokenId: livePosition.tokenId,
          outcome: livePosition.outcome,
          reason: exitReason,
          exitPrice: exitFill.averagePrice,
          filledSize: exitFill.filledSize,
          entryPrice: livePosition.entryPrice,
        });
        await this.portfolioService.clearLivePosition();
        this.logger.info(
          {
            conditionId: livePosition.conditionId,
            exitPrice: exitFill.averagePrice,
            size: exitFill.filledSize,
            reason: exitReason,
          },
          "V3 position closed",
        );
        return;
      }

      await this.portfolioService.saveLivePosition({
        ...livePosition,
        updatedAtMs: Date.now(),
      });
      this.logger.warn(
        {
          conditionId: livePosition.conditionId,
          soldSize: exitFill.filledSize,
          remainingSize,
          reason: exitReason,
        },
        "V3 exit partially filled; continuing to manage remaining position",
      );
    });

    if (!locked.executed) {
      this.logger.debug({ conditionId: livePosition.conditionId }, "V3 position skipped: lock already held");
    }
  }

  private getExecutionSize(referencePrice: number): number {
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      return 0;
    }

    const cappedSize = this.v3Config.maxExecutionValue / referencePrice;
    if (!Number.isFinite(cappedSize) || cappedSize <= 0) {
      return 0;
    }

    return Number(cappedSize.toFixed(6));
  }

  private async handleResolution(
    livePosition: V3LivePosition,
    positionsAddress: string,
  ): Promise<void> {
    const result = await this.resolutionService.process({
      livePosition,
      positionsAddress,
    });
    if (result.clear) {
      await this.portfolioService.clearLivePosition();
      this.logger.info(
        { conditionId: livePosition.conditionId },
        "V3 resolved position cleared from state",
      );
      return;
    }

    if (result.nextStatus !== livePosition.status) {
      await this.portfolioService.saveLivePosition({
        ...livePosition,
        status: result.nextStatus,
        updatedAtMs: Date.now(),
      });
    }
  }
}
