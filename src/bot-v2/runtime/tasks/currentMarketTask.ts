import type { Logger } from "pino";
import type { BotConfig } from "../../../types/domain.js";
import { MarketDiscoveryService } from "../../../services/marketDiscovery.js";
import { PolyRelayerClient } from "../../../clients/relayerClient.js";
import { NotificationService } from "../../domain/notification/notificationService.js";
import { TrackedMarketState } from "../../domain/state/trackedMarketState.js";
import { RecoveryService } from "../../domain/recovery/recoveryService.js";
import { ConditionLockService } from "../conditionLockService.js";
import { MarketSnapshotStore } from "../marketSnapshotStore.js";

export class CurrentMarketTask {
  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly marketSnapshotStore: MarketSnapshotStore,
    private readonly marketDiscovery: MarketDiscoveryService,
    private readonly relayerClient: PolyRelayerClient,
    private readonly trackedMarketState: TrackedMarketState,
    private readonly recoveryService: RecoveryService,
    private readonly conditionLocks: ConditionLockService,
    private readonly notifier: NotificationService,
    private readonly positionsAddress: string,
  ) {}

  async run(): Promise<void> {
    try {
      const staleWindowMs = Math.max(this.config.loopSleepSeconds, 1) * 2000;
      if (this.marketSnapshotStore.isStale(staleWindowMs)) {
        this.logger.warn(
          { snapshotAgeMs: this.marketSnapshotStore.getSnapshotAgeMs() },
          "Current market task skipped: stale market snapshot",
        );
        return;
      }

      const currentMarket = this.marketSnapshotStore.getSnapshot().currentMarket;
      if (!currentMarket) {
        return;
      }

      const currentConditionId = this.marketDiscovery.getConditionId(currentMarket);
      if (!currentConditionId || !this.trackedMarketState.has(currentConditionId)) {
        return;
      }

      const locked = await this.conditionLocks.withConditionLock(currentConditionId, async () => {
        await this.recoveryService.processTrackedCurrentMarket({
          currentMarket,
          currentConditionId,
          positionsAddress: this.positionsAddress,
          relayerAvailable: this.relayerClient.isAvailable(),
        });
      });

      if (!locked.executed) {
        this.logger.debug(
          { conditionId: currentConditionId },
          "Current market task skipped: condition already in flight",
        );
      }
    } catch (error) {
      this.logger.error({ error }, "Current market task error");
      await this.notifier.notifyOperationalIssue({
        title: "Current market task error",
        severity: "error",
        dedupeKey: "task-error:v2:current-market",
        error,
      });
    }
  }
}
