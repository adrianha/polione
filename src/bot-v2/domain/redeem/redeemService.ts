import type { Logger } from "pino";
import type { BotConfig, RelayerSkippedResult } from "../../../types/domain.js";
import { DataClient } from "../../../clients/dataClient.js";
import { PolyRelayerClient } from "../../../clients/relayerClient.js";
import { SettlementService } from "../../../services/settlement.js";
import { RedeemPrecheckService } from "../../../services/redeemPrecheck.js";
import { NotificationService } from "../notification/notificationService.js";
import { RedeemStateMachine } from "../state/redeemStateMachine.js";

export class RedeemService {
  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly dataClient: DataClient,
    private readonly relayerClient: PolyRelayerClient,
    private readonly settlementService: SettlementService,
    private readonly redeemPrecheckService: RedeemPrecheckService,
    private readonly redeemStateMachine: RedeemStateMachine,
    private readonly notifier: NotificationService,
  ) {}

  private isRelayerSkippedResult(value: unknown): value is RelayerSkippedResult {
    return Boolean(
      value &&
        typeof value === "object" &&
        (value as { skipped?: unknown }).skipped === true &&
        typeof (value as { reason?: unknown }).reason === "string",
    );
  }

  async processRedeemablePositions(positionsAddress: string): Promise<void> {
    if (!this.config.redeemEnabled || !this.relayerClient.isAvailable()) {
      return;
    }

    const nowMs = Date.now();
    this.redeemStateMachine.pruneTerminalStates(nowMs);

    const positions = await this.dataClient.getPositions(positionsAddress);
    const redeemableConditionIds = Array.from(
      new Set(
        positions
          .filter((position) => position.redeemable === true && typeof position.conditionId === "string")
          .map((position) => position.conditionId)
          .filter((conditionId) => conditionId.length > 0),
      ),
    );

    if (redeemableConditionIds.length === 0) {
      return;
    }

    const candidates = redeemableConditionIds.slice(0, this.config.redeemMaxPerLoop);
    for (const conditionId of candidates) {
      if (!this.redeemStateMachine.shouldAttempt(conditionId, nowMs)) {
        continue;
      }

      const precheck = await this.redeemPrecheckService.check({
        conditionId,
        positionsAddress: positionsAddress as `0x${string}`,
      });

      if (precheck.status === "not_resolved") {
        this.redeemStateMachine.scheduleRetry({
          conditionId,
          reason: precheck.reason ?? "Condition not resolved yet",
        });
        continue;
      }

      if (precheck.status === "no_redeemable_balance") {
        this.redeemStateMachine.markTerminal(
          conditionId,
          "already_redeemed",
          precheck.reason ?? "No redeemable balance",
        );
        continue;
      }

      if (precheck.status === "permanent_error") {
        this.redeemStateMachine.markTerminal(
          conditionId,
          "permanent_error",
          precheck.reason ?? "Permanent precheck error",
        );
        continue;
      }

      if (precheck.status === "retryable_error") {
        this.redeemStateMachine.scheduleRetry({
          conditionId,
          reason: precheck.reason ?? "Retryable precheck error",
          incrementAttempt: true,
        });
        continue;
      }

      this.redeemStateMachine.markSubmitted(conditionId);

      try {
        const redeem = await this.settlementService.redeemResolvedPositions(conditionId);
        await this.notifier.maybeNotifyRelayerFailover({ action: redeem, conditionId });

        if (this.isRelayerSkippedResult(redeem) && redeem.reason === "relayer_rate_limited") {
          this.redeemStateMachine.scheduleRetry({
            conditionId,
            reason: redeem.reason,
            retryAtMs: redeem.retryAt ?? Date.now() + this.config.redeemRetryBackoffMs,
          });
          continue;
        }

        if (!redeem) {
          this.redeemStateMachine.scheduleRetry({
            conditionId,
            reason: "Relayer unavailable or returned null",
            incrementAttempt: true,
          });
          continue;
        }

        this.redeemStateMachine.markTerminal(conditionId, "success");
        const relayerMeta = this.notifier.getRelayerMeta(redeem);
        this.logger.info(
          {
            redeem,
            conditionId,
            relayerBuilder: relayerMeta?.builderLabel,
            relayerFailoverFrom: relayerMeta?.failoverFrom,
          },
          "Redeem flow executed",
        );
        await this.notifier.notify({
          title: "redeemResolvedPositions executed",
          severity: "info",
          dedupeKey: `redeem-success:v2:${conditionId}`,
          conditionId,
          details: [{ key: "builder", value: relayerMeta?.builderLabel }],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.redeemStateMachine.scheduleRetry({
          conditionId,
          reason: message,
          incrementAttempt: true,
        });
      }
    }

    await this.redeemStateMachine.persist();
  }
}
