import { TelegramClient, escapeHtml, truncateId } from "../../clients/telegramClient.js";

const formatNumber = (value: number, digits = 4): string => value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

export class V3NotificationService {
  constructor(private readonly telegramClient: TelegramClient) {}

  async notifyBuy(params: {
    conditionId: string;
    slug: string;
    tokenId: string;
    outcome: string;
    entryPrice: number;
    filledSize: number;
    takeProfitPrice: number;
    stopLossPrice: number;
  }): Promise<void> {
    await this.telegramClient.sendHtml(
      this.formatMessage({
        icon: "🟢",
        title: "V3 Buy Filled",
        slug: params.slug,
        conditionId: params.conditionId,
        tokenId: params.tokenId,
        details: [
          { key: "Outcome", value: params.outcome },
          { key: "Entry", value: formatNumber(params.entryPrice) },
          { key: "Size", value: formatNumber(params.filledSize, 6) },
          { key: "TP", value: formatNumber(params.takeProfitPrice) },
          { key: "SL", value: formatNumber(params.stopLossPrice) },
        ],
      }),
      `v3-buy:${params.conditionId}`,
    );
  }

  async notifyExit(params: {
    conditionId: string;
    slug: string;
    tokenId: string;
    outcome: string;
    reason: "tp" | "sl";
    exitPrice: number;
    filledSize: number;
    entryPrice: number;
  }): Promise<void> {
    const title = params.reason === "tp" ? "V3 Take Profit Filled" : "V3 Stop Loss Filled";
    const icon = params.reason === "tp" ? "🎯" : "🛑";
    const pnlPerShare = params.exitPrice - params.entryPrice;

    await this.telegramClient.sendHtml(
      this.formatMessage({
        icon,
        title,
        slug: params.slug,
        conditionId: params.conditionId,
        tokenId: params.tokenId,
        details: [
          { key: "Outcome", value: params.outcome },
          { key: "Entry", value: formatNumber(params.entryPrice) },
          { key: "Exit", value: formatNumber(params.exitPrice) },
          { key: "Size", value: formatNumber(params.filledSize, 6) },
          { key: "PnL/share", value: formatNumber(pnlPerShare) },
        ],
      }),
      `v3-exit:${params.reason}:${params.conditionId}`,
    );
  }

  private formatMessage(params: {
    icon: string;
    title: string;
    slug: string;
    conditionId: string;
    tokenId: string;
    details: Array<{ key: string; value: string }>;
  }): string {
    const lines = [
      `<b>${params.icon} ${escapeHtml(params.title)}</b>`,
      `<b>Market</b>: <code>${escapeHtml(params.slug)}</code>`,
      `<b>Condition</b>: <code>${escapeHtml(truncateId(params.conditionId))}</code>`,
      `<b>Token</b>: <code>${escapeHtml(truncateId(params.tokenId))}</code>`,
    ];

    for (const detail of params.details) {
      lines.push(`<b>${escapeHtml(detail.key)}</b>: <code>${escapeHtml(detail.value)}</code>`);
    }

    return lines.join("\n");
  }
}
