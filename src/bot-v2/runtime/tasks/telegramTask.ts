import type { Logger } from "pino";
import type { BotConfig } from "../../../types/domain.js";
import { PolyClobClient } from "../../../clients/clobClient.js";
import { TelegramClient } from "../../../clients/telegramClient.js";
import { NotificationService } from "../../domain/notification/notificationService.js";

export class TelegramTask {
  private offset: number | undefined;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly clobClient: PolyClobClient,
    private readonly telegramClient: TelegramClient,
    private readonly notifier: NotificationService,
  ) {}

  async run(): Promise<void> {
    try {
      if (!this.telegramClient.isEnabled()) {
        return;
      }

      const updates = await this.telegramClient.getUpdates(this.offset);
      for (const update of updates) {
        this.offset = update.update_id + 1;

        const text = update.message?.text?.trim().toLowerCase();
        const chatId = update.message?.chat?.id;
        if (!text || typeof chatId !== "number") {
          continue;
        }

        if (this.config.telegramChatId && String(chatId) !== this.config.telegramChatId) {
          continue;
        }

        if (text === "/balance" || text === "/usdc" || text === "balance") {
          try {
            const balance = await this.clobClient.getUsdcBalance();
            await this.notifier.notify({
              title: "USDC balance",
              severity: "info",
              dedupeKey: `telegram-balance:v2:${Math.floor(Date.now() / 5000)}`,
              details: [
                { key: "usdc", value: balance },
                { key: "mode", value: this.config.dryRun ? "SAFE (DRY_RUN)" : "LIVE" },
              ],
            });
          } catch (error) {
            await this.notifier.notify({
              title: "USDC balance check failed",
              severity: "error",
              dedupeKey: `telegram-balance-error:v2:${Math.floor(Date.now() / 5000)}`,
              details: [
                { key: "error", value: error instanceof Error ? error.message : String(error) },
              ],
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn({ error }, "Telegram task error");
      await this.notifier.notifyOperationalIssue({
        title: "Telegram task error",
        severity: "warn",
        dedupeKey: "task-error:v2:telegram",
        error,
      });
    }
  }
}
