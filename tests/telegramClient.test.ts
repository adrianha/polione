import { describe, expect, it } from "vitest";
import { TelegramClient, escapeHtml, truncateId } from "../src/clients/telegramClient.js";

const logger = {
  warn: () => {},
};

describe("telegram client", () => {
  it("is disabled when token/chat id are missing", () => {
    const client = new TelegramClient({ logger: logger as never });
    expect(client.isEnabled()).toBe(false);
  });

  it("dedupes by key within dedupe window", () => {
    const client = new TelegramClient({
      logger: logger as never,
      botToken: "token",
      chatId: "chat",
      dedupeWindowMs: 60_000,
    });

    expect(client.shouldSend("k1")).toBe(true);
    expect(client.shouldSend("k1")).toBe(false);
    expect(client.shouldSend("k2")).toBe(true);
  });

  it("escapes html and truncates ids", () => {
    expect(escapeHtml("<a&b>")) .toBe("&lt;a&amp;b&gt;");
    expect(truncateId("0x1234567890abcdef1234567890abcdef")).toContain("...");
  });
});
