import type { Logger } from "pino";
import { DataClient } from "../../clients/dataClient.js";
import { PolyRelayerClient } from "../../clients/relayerClient.js";
import { RedeemPrecheckService } from "../../services/redeemPrecheck.js";
import { V3MarketService } from "./marketService.js";
import type { V3Config, V3LivePosition } from "../types.js";

export class V3ResolutionService {
  constructor(
    private readonly config: V3Config,
    private readonly dataClient: DataClient,
    private readonly relayerClient: PolyRelayerClient,
    private readonly redeemPrecheck: RedeemPrecheckService,
    private readonly marketService: V3MarketService,
    private readonly logger: Logger,
  ) {}

  async process(params: {
    livePosition: V3LivePosition;
    positionsAddress: string;
  }): Promise<{ clear: boolean; nextStatus: V3LivePosition["status"] }> {
    const { livePosition, positionsAddress } = params;
    const positions = await this.dataClient.getPositions(positionsAddress, livePosition.conditionId);
    const heldSize = positions.reduce((sum, position) => {
      if (position.asset !== livePosition.tokenId) {
        return sum;
      }
      const parsed = Number(position.size);
      return sum + (Number.isFinite(parsed) ? parsed : 0);
    }, 0);

    if (heldSize <= 0.0001) {
      return { clear: true, nextStatus: livePosition.status };
    }

    const marketSnapshot = await this.marketService.getMarketSnapshotBySlug(livePosition.slug);
    const marketClosed = marketSnapshot ? this.marketService.isClosed(marketSnapshot.market) : false;
    const precheck = await this.redeemPrecheck.check({
      conditionId: livePosition.conditionId,
      positionsAddress: positionsAddress as `0x${string}`,
    });

    if (precheck.status === "eligible") {
      if (!this.relayerClient.isAvailable()) {
        this.logger.warn(
          { conditionId: livePosition.conditionId },
          "V3 winning position is redeemable but relayer is unavailable; holding state",
        );
        return { clear: false, nextStatus: "awaiting_resolution" };
      }

      await this.relayerClient.redeemPositions(livePosition.conditionId, [1n, 2n]);
      return { clear: false, nextStatus: "redeeming" };
    }

    if (precheck.status === "no_redeemable_balance" && marketClosed) {
      return { clear: true, nextStatus: livePosition.status };
    }

    if (precheck.status === "permanent_error") {
      this.logger.error(
        { conditionId: livePosition.conditionId, reason: precheck.reason },
        "V3 redeem precheck failed permanently",
      );
    }

    return { clear: false, nextStatus: livePosition.status };
  }
}
