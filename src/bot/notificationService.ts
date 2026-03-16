import { escapeHtml, truncateId } from "../clients/telegramClient.js";

type BotLike = any;

export const formatTelegramMessage = (
  _bot: BotLike,
  params: {
    title: string;
    severity: "warn" | "error" | "info";
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    details: Array<{ key: string; value: string | number | null | undefined }>;
  },
): string => {
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
};

export const notify = async (
  bot: BotLike,
  params: {
    title: string;
    severity: "warn" | "error" | "info";
    dedupeKey: string;
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    details: Array<{ key: string; value: string | number | null | undefined }>;
  },
): Promise<void> => {
  const message = formatTelegramMessage(bot, params);
  await bot.telegramClient.sendHtml(message, params.dedupeKey);
};

export const notifyOperationalIssue = async (
  bot: BotLike,
  params: {
    title: string;
    severity: "warn" | "error";
    dedupeKey: string;
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    error?: unknown;
    details?: Array<{ key: string; value: string | number | null | undefined }>;
  },
): Promise<void> => {
  const details = [...(params.details ?? [])];
  if (params.error !== undefined) {
    details.push({ key: "error", value: bot.normalizeError(params.error) });
  }

  await notify(bot, {
    title: params.title,
    severity: params.severity,
    dedupeKey: params.dedupeKey,
    slug: params.slug,
    conditionId: params.conditionId,
    upTokenId: params.upTokenId,
    downTokenId: params.downTokenId,
    details,
  });
};

export const notifyPlacementSuccessOnce = async (
  bot: BotLike,
  params: {
    conditionId: string;
    slug?: string;
    upTokenId: string;
    downTokenId: string;
    entryPrice: number;
    orderSize: number;
    attempt: number;
    secondsToClose?: number | null;
    mode: "current-market" | "non-current-market";
  },
): Promise<void> => {
  const state = bot.getConditionState(params.conditionId);
  if (state.placementNotified) {
    return;
  }

  bot.patchConditionState(params.conditionId, { placementNotified: true });
  await notify(bot, {
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
      { key: "attempt", value: params.attempt },
      { key: "secondsToClose", value: params.secondsToClose },
      { key: "mode", value: params.mode },
    ],
  });
};

export const notifyEntryFilledOnce = async (
  bot: BotLike,
  params: {
    conditionId: string;
    slug?: string;
    upTokenId: string;
    downTokenId: string;
    upSize: number;
    downSize: number;
    entryPrice?: number;
    filledLegAvgPrice?: number;
    mode: "reconcile" | "continuous-recovery" | "force-window";
  },
): Promise<void> => {
  const state = bot.getConditionState(params.conditionId);
  if (state.filledNotified) {
    return;
  }

  bot.patchConditionState(params.conditionId, { filledNotified: true });
  await notify(bot, {
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
      { key: "filledLegAvgPrice", value: params.filledLegAvgPrice },
      { key: "mode", value: params.mode },
    ],
  });
};
