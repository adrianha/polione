import type { Logger } from "pino";
import { RedeemService } from "../../domain/redeem/redeemService.js";

export class RedeemTask {
  constructor(
    private readonly redeemService: RedeemService,
    private readonly logger: Logger,
    private readonly positionsAddress: string,
  ) {}

  async run(): Promise<void> {
    this.logger.debug("Running redeem task");
    await this.redeemService.processRedeemablePositions(this.positionsAddress);
  }
}
