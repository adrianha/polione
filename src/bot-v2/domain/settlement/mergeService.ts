import type { Logger } from "pino";
import type { BotConfig, TokenIds } from "../../../types/domain.js";
import { SettlementService } from "../../../services/settlement.js";
import { TradingEngine } from "../../../services/tradingEngine.js";
import { NotificationService } from "../notification/notificationService.js";

export class MergeService {
  private readonly attempted = new Set<string>();

  constructor(
    private readonly config: BotConfig,
    private readonly settlementService: SettlementService,
    private readonly tradingEngine: TradingEngine,
    private readonly notifier: NotificationService,
    private readonly logger: Logger,
  ) {}

  async tryMergeWhenBalanced(params: {
    conditionId: string;
    slug?: string;
    tokenIds: TokenIds;
    upSize: number;
    downSize: number;
    relayerAvailable: boolean;
  }): Promise<void> {
    if (!params.relayerAvailable) {
      return;
    }

    if (this.attempted.has(params.conditionId)) {
      return;
    }

    const amount = Math.min(params.upSize, params.downSize);
    if (amount <= this.config.positionEqualityTolerance) {
      return;
    }

    const merge = await this.settlementService.mergeEqualPositions(params.conditionId, amount);
    await this.notifier.maybeNotifyRelayerFailover({
      action: merge,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.tokenIds.upTokenId,
      downTokenId: params.tokenIds.downTokenId,
    });

    this.attempted.add(params.conditionId);
    this.logger.info(
      {
        merge,
        conditionId: params.conditionId,
      },
      "Merge flow executed",
    );

    await this.notifier.notify({
      title: "mergeEqualPositions executed",
      severity: "info",
      dedupeKey: `merge-success:v2:${params.conditionId}`,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.tokenIds.upTokenId,
      downTokenId: params.tokenIds.downTokenId,
      details: [{ key: "amount", value: amount }],
    });

    await this.tradingEngine.cancelEntryOpenOrders(params.tokenIds);
  }
}
