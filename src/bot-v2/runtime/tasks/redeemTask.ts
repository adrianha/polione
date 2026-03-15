import type { Logger } from "pino";
import { NotificationService } from "../../domain/notification/notificationService.js";
import { RedeemService } from "../../domain/redeem/redeemService.js";

export class RedeemTask {
  constructor(
    private readonly redeemService: RedeemService,
    private readonly notifier: NotificationService,
    private readonly logger: Logger,
    private readonly positionsAddress: string,
  ) {}

  async run(): Promise<void> {
    try {
      await this.redeemService.processRedeemablePositions(this.positionsAddress);
    } catch (error) {
      this.logger.error({ error }, "Redeem task error");
      await this.notifier.notifyOperationalIssue({
        title: "Redeem task error",
        severity: "error",
        dedupeKey: "task-error:v2:redeem",
        error,
      });
    }
  }
}
