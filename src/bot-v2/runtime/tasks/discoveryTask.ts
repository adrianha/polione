import type { Logger } from "pino";
import { MarketSnapshotService } from "../../domain/market/marketSnapshotService.js";
import { NotificationService } from "../../domain/notification/notificationService.js";

export class DiscoveryTask {
  constructor(
    private readonly marketSnapshotService: MarketSnapshotService,
    private readonly notifier: NotificationService,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    try {
      await this.marketSnapshotService.refresh();
    } catch (error) {
      this.logger.error({ error }, "Discovery task error");
      await this.notifier.notifyOperationalIssue({
        title: "Discovery task error",
        severity: "error",
        dedupeKey: "task-error:v2:discovery",
        error,
      });
    }
  }
}
