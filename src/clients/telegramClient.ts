import type { Logger } from "pino";
import { request } from "undici";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export const truncateId = (value: string, left = 8, right = 6): string => {
  if (!value) {
    return value;
  }
  if (value.length <= left + right + 3) {
    return value;
  }
  return `${value.slice(0, left)}...${value.slice(-right)}`;
};

export const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export class TelegramClient {
  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly dedupeWindowMs: number;
  private readonly messageTimeoutMs: number;
  private readonly lastSentByKey = new Map<string, number>();

  constructor(params: {
    botToken?: string;
    chatId?: string;
    logger: Logger;
    dedupeWindowMs?: number;
    messageTimeoutMs?: number;
  }) {
    this.botToken = params.botToken;
    this.chatId = params.chatId;
    this.dedupeWindowMs = params.dedupeWindowMs ?? 60_000;
    this.messageTimeoutMs = params.messageTimeoutMs ?? 3_000;
    this.logger = params.logger;
  }

  private readonly logger: Logger;

  isEnabled(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  shouldSend(dedupeKey?: string): boolean {
    if (!dedupeKey) {
      return true;
    }

    const now = Date.now();
    const prev = this.lastSentByKey.get(dedupeKey);
    if (prev !== undefined && now - prev < this.dedupeWindowMs) {
      return false;
    }

    this.lastSentByKey.set(dedupeKey, now);
    return true;
  }

  async sendHtml(message: string, dedupeKey?: string): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    if (!this.shouldSend(dedupeKey)) {
      return;
    }

    try {
      const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
      const res = await request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        headersTimeout: this.messageTimeoutMs,
        bodyTimeout: this.messageTimeoutMs,
      });

      if (res.statusCode >= 400) {
        const body = await res.body.text();
        this.logger.warn({ status: res.statusCode, body }, "Telegram send failed");
      }
    } catch (error) {
      this.logger.warn({ error }, "Telegram send error");
    }
  }
}
