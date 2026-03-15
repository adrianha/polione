import type { Logger } from "pino";
import { MarketDiscoveryService } from "../../../services/marketDiscovery.js";
import { MarketSnapshotStore } from "../../runtime/marketSnapshotStore.js";
import { NotificationService } from "../notification/notificationService.js";

export class MarketSnapshotService {
  constructor(
    private readonly marketDiscovery: MarketDiscoveryService,
    private readonly snapshotStore: MarketSnapshotStore,
    private readonly notifier: NotificationService,
    private readonly logger: Logger,
  ) {}

  async refresh(): Promise<void> {
    const [currentMarket, nextMarket] = await Promise.all([
      this.marketDiscovery.findCurrentActiveMarket(),
      this.marketDiscovery.findNextActiveMarket(),
    ]);

    this.snapshotStore.setSnapshot(currentMarket, nextMarket);

    if (!currentMarket && !nextMarket) {
      this.logger.warn("No active market found, retrying");
      await this.notifier.notifyOperationalIssue({
        title: "No active market found",
        severity: "warn",
        dedupeKey: "no-active-market:v2",
      });
    }
  }
}
