import type { Logger } from "pino";
import type { BotConfig } from "../../../types/domain.js";
import { MarketDiscoveryService } from "../../../services/marketDiscovery.js";
import { NotificationService } from "../../domain/notification/notificationService.js";
import { EntryService } from "../../domain/entry/entryService.js";
import { ConditionLockService } from "../conditionLockService.js";
import { MarketSnapshotStore } from "../marketSnapshotStore.js";

export class EntryTask {
  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly marketSnapshotStore: MarketSnapshotStore,
    private readonly marketDiscovery: MarketDiscoveryService,
    private readonly entryService: EntryService,
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
          "Entry task skipped: stale market snapshot",
        );
        return;
      }

      const snapshot = this.marketSnapshotStore.getSnapshot();
      if (!snapshot.currentMarket && !snapshot.nextMarket) {
        return;
      }

      const currentConditionId = snapshot.currentMarket
        ? this.marketDiscovery.getConditionId(snapshot.currentMarket)
        : null;
      const entryMarket = this.entryService.selectEntryMarket({
        currentMarket: snapshot.currentMarket,
        nextMarket: snapshot.nextMarket,
        currentConditionId,
      });

      if (!entryMarket) {
        return;
      }

      const entryConditionId = this.marketDiscovery.getConditionId(entryMarket);
      if (!entryConditionId) {
        await this.entryService.processEntry({
          entryMarket,
          currentConditionId,
          positionsAddress: this.positionsAddress,
        });
        return;
      }

      const locked = await this.conditionLocks.withConditionLock(entryConditionId, () =>
        this.entryService.processEntry({
          entryMarket,
          currentConditionId,
          positionsAddress: this.positionsAddress,
        }),
      );

      if (!locked.executed) {
        this.logger.debug(
          { conditionId: entryConditionId },
          "Entry task skipped: condition already in flight",
        );
      }
    } catch (error) {
      this.logger.error({ error }, "Entry task error");
      await this.notifier.notifyOperationalIssue({
        title: "Entry task error",
        severity: "error",
        dedupeKey: "task-error:v2:entry",
        error,
      });
    }
  }
}
