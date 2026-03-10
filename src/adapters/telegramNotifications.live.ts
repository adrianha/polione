import { Effect, Layer } from "effect";
import type { Logger } from "pino";
import { adapterError } from "../app/errors.js";
import { Notifications, type NotificationPayload, type Notifications as NotificationsPort } from "../ports/Notifications.js";
import { TelegramClient, escapeHtml, truncateId } from "../clients/telegramClient.js";

const formatTelegramMessage = (params: NotificationPayload): string => {
  const icon = params.severity === "error" ? "ERROR" : params.severity === "warn" ? "WARN" : "INFO";
  const lines = [`<b>${escapeHtml(icon)} ${escapeHtml(params.title)}</b>`];

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

export const makeTelegramNotifications = (client: TelegramClient): NotificationsPort => ({
  send: (payload) =>
    Effect.tryPromise({
      try: () => client.sendHtml(formatTelegramMessage(payload), payload.dedupeKey),
      catch: (cause) => adapterError({ adapter: "TelegramClient", operation: "sendHtml", cause }),
    }),
});

export const makeTelegramClient = (params: {
  botToken?: string;
  chatId?: string;
  logger: Logger;
  dedupeWindowMs?: number;
  messageTimeoutMs?: number;
}): TelegramClient => new TelegramClient(params);

export const TelegramNotificationsLive = (client: TelegramClient): Layer.Layer<NotificationsPort> =>
  Layer.succeed(Notifications, makeTelegramNotifications(client));
