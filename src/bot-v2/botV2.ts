import type { Logger } from "pino";
import type { BotConfig } from "../types/domain.js";
import { GammaClient } from "../clients/gammaClient.js";
import { PolyClobClient } from "../clients/clobClient.js";
import { PolyRelayerClient } from "../clients/relayerClient.js";
import { DataClient } from "../clients/dataClient.js";
import { TelegramClient } from "../clients/telegramClient.js";
import { MarketDiscoveryService } from "../services/marketDiscovery.js";
import { TradingEngine } from "../services/tradingEngine.js";
import { SettlementService } from "../services/settlement.js";
import { RedeemPrecheckService } from "../services/redeemPrecheck.js";
import { StateStore } from "../utils/stateStore.js";
import { Scheduler } from "./runtime/scheduler.js";
import { ConditionLockService } from "./runtime/conditionLockService.js";
import { MarketSnapshotStore } from "./runtime/marketSnapshotStore.js";
import { NotificationService } from "./domain/notification/notificationService.js";
import { TrackedMarketState } from "./domain/state/trackedMarketState.js";
import { RedeemStateMachine } from "./domain/state/redeemStateMachine.js";
import { MarketSnapshotService } from "./domain/market/marketSnapshotService.js";
import { EntryService } from "./domain/entry/entryService.js";
import { MergeService } from "./domain/settlement/mergeService.js";
import { RecoveryService } from "./domain/recovery/recoveryService.js";
import { RedeemService } from "./domain/redeem/redeemService.js";
import { DiscoveryTask } from "./runtime/tasks/discoveryTask.js";
import { EntryTask } from "./runtime/tasks/entryTask.js";
import { CurrentMarketTask } from "./runtime/tasks/currentMarketTask.js";
import { RedeemTask } from "./runtime/tasks/redeemTask.js";
import { TelegramTask } from "./runtime/tasks/telegramTask.js";

export class PolymarketBotV2 {
  private stopped = false;
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
  private readonly scheduler: Scheduler;
  private readonly schedulerTickSeconds: number;
  private readonly discoveryIntervalSeconds: number;
  private readonly currentMarketIntervalSeconds: number;
  private readonly entryIntervalSeconds: number;
  private readonly redeemIntervalSeconds: number;
  private readonly telegramPollIntervalSeconds: number;

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
    this.schedulerTickSeconds = Math.max(0.2, config.schedulerTickSeconds ?? 1);
    this.discoveryIntervalSeconds =
      config.discoveryIntervalSeconds ?? config.loopSleepSeconds;
    this.currentMarketIntervalSeconds =
      config.currentMarketIntervalSeconds ?? config.currentLoopSleepSeconds;
    this.entryIntervalSeconds = config.entryIntervalSeconds ?? config.loopSleepSeconds;
    this.redeemIntervalSeconds = config.redeemIntervalSeconds ?? config.redeemLoopSleepSeconds;
    this.telegramPollIntervalSeconds =
      config.telegramPollIntervalSeconds ?? Math.max(2, config.loopSleepSeconds);
    this.scheduler = new Scheduler(logger, this.schedulerTickSeconds);
  }

  stop(): void {
    this.stopped = true;
    this.scheduler.stop();
  }

  async runForever(): Promise<void> {
    await this.clobClient.init();
    const userAddress = this.clobClient.getSignerAddress();
    const positionsAddress = this.config.funder ?? userAddress;

    const notifier = new NotificationService(this.telegramClient, this.logger);
    const trackedMarketState = new TrackedMarketState(this.stateStore, this.logger);
    const redeemStateMachine = new RedeemStateMachine(this.config, this.stateStore);
    await trackedMarketState.load();
    await redeemStateMachine.load();

    const conditionLocks = new ConditionLockService();
    const marketSnapshotStore = new MarketSnapshotStore();
    const marketSnapshotService = new MarketSnapshotService(
      this.marketDiscovery,
      marketSnapshotStore,
      notifier,
      this.logger,
    );
    const mergeService = new MergeService(
      this.config,
      this.settlementService,
      this.tradingEngine,
      notifier,
      this.logger,
    );
    const recoveryService = new RecoveryService(
      this.config,
      this.logger,
      this.marketDiscovery,
      this.tradingEngine,
      this.dataClient,
      notifier,
      mergeService,
    );
    const entryService = new EntryService(
      this.config,
      this.logger,
      this.marketDiscovery,
      this.tradingEngine,
      this.dataClient,
      this.clobClient,
      trackedMarketState,
      notifier,
    );
    const redeemService = new RedeemService(
      this.config,
      this.logger,
      this.dataClient,
      this.relayerClient,
      this.settlementService,
      this.redeemPrecheckService,
      redeemStateMachine,
      notifier,
    );

    const discoveryTask = new DiscoveryTask(marketSnapshotService, notifier, this.logger);
    const currentMarketTask = new CurrentMarketTask(
      this.config,
      this.logger,
      marketSnapshotStore,
      this.marketDiscovery,
      this.relayerClient,
      trackedMarketState,
      recoveryService,
      conditionLocks,
      notifier,
      positionsAddress,
    );
    const entryTask = new EntryTask(
      this.config,
      this.logger,
      marketSnapshotStore,
      this.marketDiscovery,
      entryService,
      conditionLocks,
      notifier,
      positionsAddress,
    );
    const redeemTask = new RedeemTask(redeemService, notifier, this.logger, positionsAddress);
    const telegramTask = new TelegramTask(
      this.config,
      this.logger,
      this.clobClient,
      this.telegramClient,
      notifier,
    );

    this.logger.info(
      {
        dryRun: this.config.dryRun,
        userAddress,
        positionsAddress,
        relayerEnabled: this.relayerClient.isAvailable(),
        availableRelayerBuilders: this.relayerClient.getAvailableBuilderLabels(),
        persistedTrackedMarketCount: trackedMarketState.values().size,
        persistedRedeemStateCount: redeemStateMachine.size(),
        stateFilePath: this.config.stateFilePath,
      },
      "Bot V2 initialized",
    );

    await notifier.notify({
      title: "Bot V2 started",
      severity: "info",
      dedupeKey: `bot-v2-start:${Math.floor(Date.now() / 60000)}`,
      details: [
        { key: "mode", value: this.config.dryRun ? "SAFE (DRY_RUN)" : "LIVE" },
        { key: "chainId", value: this.config.chainId },
        { key: "userAddress", value: userAddress },
        { key: "positionsAddress", value: positionsAddress },
      ],
    });

    await marketSnapshotService.refresh();

    this.scheduler.register({
      name: "discovery",
      intervalSeconds: this.discoveryIntervalSeconds,
      run: () => discoveryTask.run(),
    });
    this.scheduler.register({
      name: "current-market",
      intervalSeconds: this.currentMarketIntervalSeconds,
      run: () => currentMarketTask.run(),
    });
    this.scheduler.register({
      name: "entry",
      intervalSeconds: this.entryIntervalSeconds,
      run: () => entryTask.run(),
    });
    this.scheduler.register({
      name: "redeem",
      intervalSeconds: this.redeemIntervalSeconds,
      run: () => redeemTask.run(),
    });
    this.scheduler.register({
      name: "telegram",
      intervalSeconds: this.telegramPollIntervalSeconds,
      run: () => telegramTask.run(),
    });

    await this.scheduler.runForever();

    if (!this.stopped) {
      return;
    }

    await notifier.notify({
      title: "Bot V2 stopped",
      severity: "warn",
      dedupeKey: `bot-v2-stop:${Math.floor(Date.now() / 60000)}`,
      details: [
        { key: "mode", value: this.config.dryRun ? "SAFE (DRY_RUN)" : "LIVE" },
        { key: "trackedMarketCount", value: trackedMarketState.values().size },
        { key: "stateFilePath", value: this.config.stateFilePath },
      ],
    });

    this.logger.info("Bot V2 stopped");
  }
}
