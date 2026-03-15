import type { Logger } from "pino";
import { TelegramClient, escapeHtml, truncateId } from "../../../clients/telegramClient.js";

export class NotificationService {
  private readonly notifiedPlacementSuccess = new Set<string>();
  private readonly notifiedEntryFilled = new Set<string>();
  private relayerFailoverActive = false;

  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly logger: Logger,
  ) {}

  formatMessage(params: {
    title: string;
    severity: "warn" | "error" | "info";
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    details: Array<{ key: string; value: string | number | null | undefined }>;
  }): string {
    const icon = params.severity === "error" ? "❌" : params.severity === "warn" ? "⚠️" : "✅";
    const lines = [`<b>${icon} ${escapeHtml(params.title)}</b>`];

    if (params.slug) {
      lines.push(`<b>Market</b>: <code>${escapeHtml(params.slug)}</code>`);
    }
    if (params.conditionId) {
      lines.push(`<b>Condition</b>: <code>${escapeHtml(truncateId(params.conditionId))}</code>`);
    }
    if (params.upTokenId || params.downTokenId) {
      lines.push(
        `<b>Tokens</b>: UP <code>${escapeHtml(truncateId(params.upTokenId ?? "-"))}</code> | DOWN <code>${escapeHtml(
          truncateId(params.downTokenId ?? "-"),
        )}</code>`,
      );
    }

    for (const detail of params.details) {
      if (detail.value === null || detail.value === undefined || detail.value === "") {
        continue;
      }
      lines.push(`<b>${escapeHtml(detail.key)}</b>: <code>${escapeHtml(String(detail.value))}</code>`);
    }

    return lines.join("\n");
  }

  async notify(params: {
    title: string;
    severity: "warn" | "error" | "info";
    dedupeKey: string;
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    details: Array<{ key: string; value: string | number | null | undefined }>;
  }): Promise<void> {
    const message = this.formatMessage(params);
    await this.telegramClient.sendHtml(message, params.dedupeKey);
  }

  async notifyOperationalIssue(params: {
    title: string;
    severity: "warn" | "error";
    dedupeKey: string;
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    error?: unknown;
    details?: Array<{ key: string; value: string | number | null | undefined }>;
  }): Promise<void> {
    const details = [...(params.details ?? [])];
    if (params.error !== undefined) {
      const message = params.error instanceof Error ? params.error.message : String(params.error);
      details.push({ key: "error", value: message });
    }

    await this.notify({
      title: params.title,
      severity: params.severity,
      dedupeKey: params.dedupeKey,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.upTokenId,
      downTokenId: params.downTokenId,
      details,
    });
  }

  async notifyPlacementSuccessOnce(params: {
    conditionId: string;
    slug?: string;
    upTokenId: string;
    downTokenId: string;
    entryPrice: number;
    orderSize: number;
    mode: "current-market" | "non-current-market";
    secondsToClose?: number | null;
  }): Promise<void> {
    if (this.notifiedPlacementSuccess.has(params.conditionId)) {
      return;
    }
    this.notifiedPlacementSuccess.add(params.conditionId);

    await this.notify({
      title: "Paired limit orders placed",
      severity: "info",
      dedupeKey: `placement-success:${params.conditionId}`,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.upTokenId,
      downTokenId: params.downTokenId,
      details: [
        { key: "entryPrice", value: params.entryPrice },
        { key: "orderSize", value: params.orderSize },
        { key: "secondsToClose", value: params.secondsToClose },
        { key: "mode", value: params.mode },
      ],
    });
  }

  async notifyEntryFilledOnce(params: {
    conditionId: string;
    slug?: string;
    upTokenId: string;
    downTokenId: string;
    upSize: number;
    downSize: number;
    entryPrice?: number;
    mode: "reconcile" | "continuous-recovery" | "force-window";
  }): Promise<void> {
    if (this.notifiedEntryFilled.has(params.conditionId)) {
      return;
    }
    this.notifiedEntryFilled.add(params.conditionId);

    await this.notify({
      title: "Entry filled and balanced",
      severity: "info",
      dedupeKey: `entry-filled:${params.conditionId}`,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.upTokenId,
      downTokenId: params.downTokenId,
      details: [
        { key: "up", value: params.upSize },
        { key: "down", value: params.downSize },
        { key: "entryPrice", value: params.entryPrice },
        { key: "mode", value: params.mode },
      ],
    });
  }

  getRelayerMeta(result: unknown): { builderLabel?: string; failoverFrom?: string } | null {
    if (!result || typeof result !== "object") {
      return null;
    }

    const meta = (result as Record<string, unknown>).meta;
    if (!meta || typeof meta !== "object") {
      return null;
    }

    const metaObj = meta as Record<string, unknown>;
    return {
      builderLabel: typeof metaObj.builderLabel === "string" ? metaObj.builderLabel : undefined,
      failoverFrom: typeof metaObj.failoverFrom === "string" ? metaObj.failoverFrom : undefined,
    };
  }

  async maybeNotifyRelayerFailover(params: {
    action: unknown;
    slug?: string;
    conditionId: string;
    upTokenId?: string;
    downTokenId?: string;
  }): Promise<void> {
    const meta = this.getRelayerMeta(params.action);
    if (!meta) {
      return;
    }

    if (meta.builderLabel === "builder1") {
      this.relayerFailoverActive = false;
      return;
    }

    if (!meta.failoverFrom || this.relayerFailoverActive) {
      return;
    }

    this.relayerFailoverActive = true;
    await this.notify({
      title: "Relayer failover activated",
      severity: "warn",
      dedupeKey: `relayer-failover:${meta.failoverFrom}:${meta.builderLabel}`,
      slug: params.slug,
      conditionId: params.conditionId,
      upTokenId: params.upTokenId,
      downTokenId: params.downTokenId,
      details: [
        { key: "fromBuilder", value: meta.failoverFrom },
        { key: "toBuilder", value: meta.builderLabel },
      ],
    });
  }

  loggerRef(): Logger {
    return this.logger;
  }
}
