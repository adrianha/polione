import type { Logger } from "pino";
import { MarketSnapshotService } from "../../domain/market/marketSnapshotService.js";

export class DiscoveryTask {
  constructor(
    private readonly marketSnapshotService: MarketSnapshotService,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    this.logger.debug("Running discovery task");
    await this.marketSnapshotService.refresh();
  }
}
