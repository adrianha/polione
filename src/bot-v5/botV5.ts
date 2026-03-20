import type { Logger } from "pino";
import type { BotConfig, MarketRecord, TokenIds } from "../types/domain.js";
import { GammaClient } from "../clients/gammaClient.js";
import { PolyClobClient } from "../clients/clobClient.js";
import { DataClient } from "../clients/dataClient.js";
import { ClobWsClient } from "../clients/clobWsClient.js";
import { TelegramClient, escapeHtml, truncateId } from "../clients/telegramClient.js";
import { sleep, unixNow, getCurrentEpochTimestamp } from "../utils/time.js";
import type { V5Config } from "./config.js";
import type { V5Position, V5State, ExitReason } from "./types.js";
import { promises as fs } from "node:fs";
import path from "node:path";

interface TradeLogEntry {
  slug: string;
  side: "up" | "down";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  exitReason: ExitReason;
  holdSeconds: number;
  trailingTpActivated: boolean;
  highWaterMark: number;
  timestamp: string;
}

const parseClobTokenIds = (raw: unknown): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      return [];
    }
  }
  return [];
};

const parseTokens = (market: MarketRecord): TokenIds | null => {
  const clob = parseClobTokenIds(market.clobTokenIds);
  if (clob.length >= 2) {
    return { upTokenId: clob[0], downTokenId: clob[1] };
  }
  if (Array.isArray(market.tokens) && market.tokens.length >= 2) {
    const tokenA = market.tokens[0] as Record<string, unknown>;
    const tokenB = market.tokens[1] as Record<string, unknown>;
    if (typeof tokenA.token_id === "string" && typeof tokenB.token_id === "string") {
      return { upTokenId: tokenA.token_id, downTokenId: tokenB.token_id };
    }
  }
  return null;
};

const roundPrice = (price: number): number => Number(price.toFixed(4));

export class PolymarketBotV5 {
  private stopped = false;
  private state: V5State = { positions: {} };

  private readonly gammaClient: GammaClient;
  private readonly clobClient: PolyClobClient;
  private readonly dataClient: DataClient;
  private readonly wsClient: ClobWsClient;
  private readonly telegramClient: TelegramClient;

  constructor(
    private readonly config: BotConfig,
    private readonly v5Config: V5Config,
    private readonly logger: Logger,
  ) {
    this.gammaClient = new GammaClient(config);
    this.clobClient = new PolyClobClient(config);
    this.dataClient = new DataClient(config);
    this.wsClient = new ClobWsClient(config, logger);
    this.telegramClient = new TelegramClient({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
      logger,
    });
  }

  stop(): void {
    this.stopped = true;
    this.wsClient.stop();
  }

  async runForever(): Promise<void> {
    await this.clobClient.init();
    await this.loadState();
    this.logger.info(
      {
        slugPrefixes: this.v5Config.slugPrefixes,
        entryThreshold: this.v5Config.entryThreshold,
        maxEntryPrice: this.v5Config.maxEntryPrice,
        tpOffset: `$+${Math.abs(this.v5Config.takeProfitPrice - 0.85).toFixed(2)}`,
        slOffset: `$-${Math.abs(0.85 - this.v5Config.stopLossPrice).toFixed(2)}`,
        rrRatio: `${(Math.abs(this.v5Config.takeProfitPrice - 0.85) / Math.abs(0.85 - this.v5Config.stopLossPrice)).toFixed(1)}:1`,
        trailingTp: this.v5Config.trailingTp,
        maxUsdcPerTrade: this.v5Config.maxUsdcPerTrade,
        maxOpenPositions: this.v5Config.maxOpenPositions,
      },
      "Bot V5 started",
    );

    this.wsClient.start();

    while (!this.stopped) {
      try {
        await this.tick();
      } catch (error) {
        this.logger.error({ error }, "Bot V5 tick error");
      }
      await sleep(this.v5Config.loopIntervalSeconds);
    }

    this.logger.info("Bot V5 stopped");
  }

  private async tick(): Promise<void> {
    for (const prefix of this.v5Config.slugPrefixes) {
      if (this.stopped) break;
      await this.processSlugPrefix(prefix);
    }
  }

  private async processSlugPrefix(prefix: string): Promise<void> {
    const slug = this.buildCurrentSlug(prefix);
    const existingPosition = this.state.positions[slug];

    if (existingPosition?.state === "closed") {
      return;
    }

    if (existingPosition) {
      await this.managePosition(existingPosition);
      return;
    }

    const openCount = Object.values(this.state.positions).filter(
      (p) => p.state !== "closed",
    ).length;
    if (openCount >= this.v5Config.maxOpenPositions) {
      return;
    }

    let market: MarketRecord | null;
    try {
      market = await this.gammaClient.getMarketBySlug(slug);
    } catch (error) {
      this.logger.warn({ slug, error }, "Failed to fetch market");
      return;
    }

    if (!market) {
      return;
    }

    const conditionId = market.conditionId ?? market.condition_id;
    if (!conditionId) {
      this.logger.warn({ slug }, "Market missing conditionId");
      return;
    }

    if (market.closed || market.archived) {
      return;
    }

    const tokenIds = parseTokens(market);
    if (!tokenIds) {
      this.logger.warn({ slug }, "Could not parse token IDs");
      return;
    }

    this.wsClient.ensureSubscribed([tokenIds.upTokenId, tokenIds.downTokenId]);

    const upQuote = this.wsClient.getFreshQuote(tokenIds.upTokenId);
    const downQuote = this.wsClient.getFreshQuote(tokenIds.downTokenId);

    if (!upQuote || !downQuote) {
      return;
    }

    const upAsk = upQuote.bestAsk;
    const downAsk = downQuote.bestAsk;

    let favoriteTokenId: string | null = null;
    let favoriteSide: "up" | "down" | null = null;
    let favoriteAsk = 0;

    if (upAsk >= this.v5Config.entryThreshold) {
      favoriteTokenId = tokenIds.upTokenId;
      favoriteSide = "up";
      favoriteAsk = upAsk;
    } else if (downAsk >= this.v5Config.entryThreshold) {
      favoriteTokenId = tokenIds.downTokenId;
      favoriteSide = "down";
      favoriteAsk = downAsk;
    }

    if (!favoriteTokenId || !favoriteSide) {
      return;
    }

    const maxEntryPrice = this.v5Config.maxEntryPrice;
    if (favoriteAsk > maxEntryPrice) {
      this.logger.debug(
        { slug, favoriteSide, favoriteAsk, maxEntryPrice },
        "Favorite price above max entry, skipping",
      );
      return;
    }

    this.logger.info(
      { slug, favoriteSide, favoriteAsk, threshold: this.v5Config.entryThreshold },
      "Favorite detected, entering position",
    );

    await this.enterPosition({
      conditionId,
      slug,
      tokenIds,
      favoriteTokenId,
      favoriteSide,
      estimatedPrice: favoriteAsk,
    });
  }

  private async enterPosition(params: {
    conditionId: string;
    slug: string;
    tokenIds: TokenIds;
    favoriteTokenId: string;
    favoriteSide: "up" | "down";
    estimatedPrice: number;
  }): Promise<void> {
    const { conditionId, slug, tokenIds, favoriteTokenId, favoriteSide, estimatedPrice } = params;

    const position: V5Position = {
      conditionId,
      slug,
      tokenIds,
      favoriteTokenId,
      favoriteSide,
      entryPrice: 0,
      size: this.v5Config.maxUsdcPerTrade,
      filledSize: 0,
      state: "entering",
      highWaterMark: 0,
      entryOrderId: null,
      tpOrderId: null,
      slOrderId: null,
      trailingTpOrderId: null,
      trailingTpActivated: false,
      exitReason: null,
      filledAtMs: null,
      closedAtMs: null,
      createdAtMs: Date.now(),
    };

    this.state.positions[slug] = position;
    await this.saveState();

    try {
      const result = await this.clobClient.placeMarketOrder({
        tokenId: favoriteTokenId,
        side: "BUY",
        amount: this.v5Config.maxUsdcPerTrade,
        price: roundPrice(estimatedPrice),
      });

      const entryOrderId = this.extractOrderId(result);
      position.entryOrderId = entryOrderId;

      this.logger.info(
        { slug, favoriteSide, estimatedPrice, maxUsdc: this.v5Config.maxUsdcPerTrade, entryOrderId },
        "Entry market order placed",
      );

      await this.waitForEntryFill(position);
    } catch (error) {
      this.logger.error({ slug, error }, "Entry order failed");
      position.state = "closed";
      position.closedAtMs = Date.now();
      await this.saveState();
      await this.notifyEntryError(slug, error);
    }
  }

  private async waitForEntryFill(position: V5Position): Promise<void> {
    if (this.config.dryRun) {
      await this.waitForEntryFillDryRun(position);
      return;
    }

    const deadline = Date.now() + this.v5Config.orderFillTimeoutMs;

    while (Date.now() < deadline && !this.stopped) {
      try {
        const positions = await this.dataClient.getPositions(
          this.clobClient.getSignerAddress(),
          position.conditionId,
        );

        const favPosition = positions.find((p) => p.asset === position.favoriteTokenId);
        if (favPosition && favPosition.size > 0) {
          const filledSize = Number(favPosition.size);
          position.filledSize = filledSize;
          position.entryPrice = this.estimateEntryPrice(position);
          position.state = "open";
          position.filledAtMs = Date.now();
          position.highWaterMark = position.entryPrice;

          this.logger.info(
            { slug: position.slug, filledSize, entryPrice: position.entryPrice },
            "Entry filled",
          );

          await this.saveState();
          await this.notifyEntryFilled(position);
          await this.placeExitOrders(position);
          return;
        }
      } catch {
        // Retry
      }

      await sleep(this.v5Config.orderFillPollIntervalMs / 1000);
    }

    this.logger.warn({ slug: position.slug }, "Entry fill timeout");
    position.state = "closed";
    position.closedAtMs = Date.now();
    await this.saveState();
  }

  private async waitForEntryFillDryRun(position: V5Position): Promise<void> {
    const quote = this.wsClient.getFreshQuote(position.favoriteTokenId);
    const entryPrice = quote ? quote.bestAsk : this.v5Config.entryThreshold;

    position.filledSize = position.size;
    position.entryPrice = roundPrice(entryPrice);
    position.state = "open";
    position.filledAtMs = Date.now();
    position.highWaterMark = position.entryPrice;

    this.logger.info(
      {
        slug: position.slug,
        filledSize: position.filledSize,
        entryPrice: position.entryPrice,
        dryRun: true,
      },
      "[DRY RUN] Entry filled",
    );

    await this.saveState();
    await this.placeExitOrders(position);
  }

  private estimateEntryPrice(position: V5Position): number {
    const quote = this.wsClient.getFreshQuote(position.favoriteTokenId);
    if (quote) {
      return quote.bestAsk;
    }
    return this.v5Config.entryThreshold;
  }

  private async placeExitOrders(position: V5Position): Promise<void> {
    try {
      const size = position.filledSize;

      if (size <= 0) {
        this.logger.warn({ slug: position.slug }, "No filled size to exit");
        return;
      }

      const slPrice = this.computeSlPrice(position.entryPrice);
      const tpPrice = this.computeTpPrice(position.entryPrice);

      const slResult = await this.clobClient.placeLimitOrder({
        tokenId: position.favoriteTokenId,
        side: "SELL",
        price: slPrice,
        size,
      });
      position.slOrderId = this.extractOrderId(slResult);

      this.logger.info(
        {
          slug: position.slug,
          entryPrice: position.entryPrice,
          slPrice,
          slOrderId: position.slOrderId,
        },
        "Stop loss order placed",
      );

      if (!this.v5Config.trailingTp) {
        const tpResult = await this.clobClient.placeLimitOrder({
          tokenId: position.favoriteTokenId,
          side: "SELL",
          price: tpPrice,
          size,
        });
        position.tpOrderId = this.extractOrderId(tpResult);

        this.logger.info(
          {
            slug: position.slug,
            entryPrice: position.entryPrice,
            tpPrice,
            tpOrderId: position.tpOrderId,
          },
          "Take profit order placed",
        );
      }

      position.state = "exiting";
      await this.saveState();
    } catch (error) {
      this.logger.error({ slug: position.slug, error }, "Failed to place exit orders");
      await this.notifyExitError(position.slug, "Failed to place exit orders", error);
    }
  }

  private async managePosition(position: V5Position): Promise<void> {
    if (position.state === "entering") {
      return;
    }

    if (position.state === "closed") {
      return;
    }

    if (position.state === "open") {
      await this.placeExitOrders(position);
      return;
    }

    // state === "exiting"
    const quote = this.wsClient.getFreshQuote(position.favoriteTokenId);

    if (quote && this.v5Config.trailingTp) {
      await this.manageTrailingTp(position, quote);
    }

    await this.checkExitFills(position);
  }

  private async manageTrailingTp(
    position: V5Position,
    quote: { bestBid: number; bestAsk: number },
  ): Promise<void> {
    const currentPrice = quote.bestBid;
    const activationPrice = this.computeTpPrice(position.entryPrice);

    if (currentPrice > position.highWaterMark) {
      position.highWaterMark = currentPrice;
    }

    if (
      !position.trailingTpActivated &&
      position.highWaterMark >= activationPrice
    ) {
      position.trailingTpActivated = true;

      try {
        if (position.tpOrderId) {
          await this.clobClient.cancelOrder(position.tpOrderId);
          position.tpOrderId = null;
        }

        const trailingResult = await this.clobClient.placeLimitOrder({
          tokenId: position.favoriteTokenId,
          side: "SELL",
          price: activationPrice,
          size: position.filledSize,
        });
        position.trailingTpOrderId = this.extractOrderId(trailingResult);

        this.logger.info(
          {
            slug: position.slug,
            entryPrice: position.entryPrice,
            hwm: position.highWaterMark,
            activationPrice,
            trailingOrderId: position.trailingTpOrderId,
          },
          "Trailing TP activated",
        );

        await this.saveState();
        await this.notifyTrailingActivated(position);
      } catch (error) {
        this.logger.error({ slug: position.slug, error }, "Failed to place trailing TP order");
      }
    }
  }

  private async checkExitFills(position: V5Position): Promise<void> {
    if (this.config.dryRun) {
      await this.checkExitFillsDryRun(position);
      return;
    }

    try {
      const positions = await this.dataClient.getPositions(
        this.clobClient.getSignerAddress(),
        position.conditionId,
      );

      const favPosition = positions.find((p) => p.asset === position.favoriteTokenId);
      const currentSize = favPosition ? Number(favPosition.size) : 0;

      if (currentSize <= 0 && position.filledSize > 0) {
        let exitReason: ExitReason = "market_resolved";

        if (position.tpOrderId || position.trailingTpOrderId) {
          const quote = this.wsClient.getFreshQuote(position.favoriteTokenId);
          const exitPrice = quote ? quote.bestBid : 0;
          const tpPrice = this.computeTpPrice(position.entryPrice);
          const slPrice = this.computeSlPrice(position.entryPrice);

          if (exitPrice >= tpPrice - 0.01) {
            exitReason = position.trailingTpActivated ? "trailing_tp" : "take_profit";
          } else if (exitPrice <= slPrice + 0.01) {
            exitReason = "stop_loss";
          } else {
            exitReason = position.trailingTpActivated ? "trailing_tp" : "take_profit";
          }
        }

        await this.closePosition(position, exitReason);
        return;
      }

      if (favPosition?.redeemable) {
        await this.closePosition(position, "market_resolved");
        return;
      }
    } catch (error) {
      this.logger.warn({ slug: position.slug, error }, "Failed to check exit fills");
    }
  }

  private computeTpPrice(entryPrice: number): number {
    const offset = Math.abs(this.v5Config.takeProfitPrice - 0.85);
    return roundPrice(Math.min(0.99, entryPrice + offset));
  }

  private computeSlPrice(entryPrice: number): number {
    const offset = Math.abs(0.85 - this.v5Config.stopLossPrice);
    return roundPrice(Math.max(0, entryPrice - offset));
  }

  private async checkExitFillsDryRun(position: V5Position): Promise<void> {
    const quote = this.wsClient.getFreshQuote(position.favoriteTokenId);
    if (!quote) return;

    const currentBid = quote.bestBid;

    if (currentBid > position.highWaterMark) {
      position.highWaterMark = currentBid;
    }

    const tpPrice = this.computeTpPrice(position.entryPrice);
    const slPrice = this.computeSlPrice(position.entryPrice);

    // Stop loss hit
    if (currentBid <= slPrice) {
      await this.closePositionDryRun(position, "stop_loss", slPrice);
      return;
    }

    // Trailing TP mode
    if (this.v5Config.trailingTp) {
      const activationPrice = this.computeTpPrice(position.entryPrice);
      if (
        !position.trailingTpActivated &&
        position.highWaterMark >= activationPrice
      ) {
        position.trailingTpActivated = true;
        this.logger.info(
          { slug: position.slug, hwm: position.highWaterMark, activationPrice, dryRun: true },
          "[DRY RUN] Trailing TP activated",
        );
        await this.saveState();
      }

      if (position.trailingTpActivated && currentBid <= activationPrice) {
        await this.closePositionDryRun(position, "trailing_tp", activationPrice);
        return;
      }
    }
    // Fixed TP mode
    else {
      if (currentBid >= tpPrice) {
        await this.closePositionDryRun(position, "take_profit", tpPrice);
        return;
      }
    }

    // Check if market is about to close (within 10 seconds of end)
    const slugParts = position.slug.split("-");
    const epochStr = slugParts[slugParts.length - 1];
    const epoch = Number(epochStr);
    if (Number.isFinite(epoch)) {
      const endTime = epoch + this.v5Config.marketIntervalSeconds;
      const now = unixNow();
      if (now >= endTime - 10) {
        await this.closePositionDryRun(position, "market_resolved", currentBid);
        return;
      }
    }
  }

  private async closePositionDryRun(
    position: V5Position,
    reason: ExitReason,
    exitPrice: number,
  ): Promise<void> {
    position.state = "closed";
    position.exitReason = reason;
    position.closedAtMs = Date.now();

    const pnl = roundPrice((exitPrice - position.entryPrice) * position.filledSize);
    const pnlPct = position.entryPrice > 0 ? roundPrice((exitPrice - position.entryPrice) / position.entryPrice) : 0;
    const holdSeconds = position.filledAtMs
      ? Math.round((Date.now() - position.filledAtMs) / 1000)
      : 0;

    this.logger.info(
      {
        slug: position.slug,
        side: position.favoriteSide,
        entryPrice: position.entryPrice,
        exitPrice: roundPrice(exitPrice),
        size: position.filledSize,
        pnl,
        pnlPct,
        reason,
        holdSeconds,
        hwm: position.highWaterMark,
        trailingTpActivated: position.trailingTpActivated,
        dryRun: true,
      },
      "[DRY RUN] Position closed",
    );

    await this.appendTradeLog({
      slug: position.slug,
      side: position.favoriteSide,
      entryPrice: position.entryPrice,
      exitPrice: roundPrice(exitPrice),
      size: position.filledSize,
      pnl,
      pnlPct,
      exitReason: reason,
      holdSeconds,
      trailingTpActivated: position.trailingTpActivated,
      highWaterMark: position.highWaterMark,
      timestamp: new Date().toISOString(),
    });

    await this.saveState();
  }

  private async closePosition(position: V5Position, reason: ExitReason): Promise<void> {
    position.state = "closed";
    position.exitReason = reason;
    position.closedAtMs = Date.now();

    await this.cancelAllOrders(position);
    await this.saveState();

    const pnl = this.estimatePnl(position);
    this.logger.info(
      { slug: position.slug, reason, entryPrice: position.entryPrice, pnl },
      "Position closed",
    );

    await this.notifyPositionClosed(position, reason, pnl);
  }

  private estimatePnl(position: V5Position): number {
    const quote = this.wsClient.getFreshQuote(position.favoriteTokenId);
    const exitPrice = quote ? quote.bestBid : 0;
    return roundPrice((exitPrice - position.entryPrice) * position.filledSize);
  }

  private async cancelAllOrders(position: V5Position): Promise<void> {
    const orderIds = [
      position.tpOrderId,
      position.slOrderId,
      position.trailingTpOrderId,
    ].filter((id): id is string => id !== null);

    if (orderIds.length === 0) return;

    try {
      await this.clobClient.cancelOrders(orderIds);
      this.logger.debug({ slug: position.slug, orderIds }, "Cancelled exit orders");
    } catch (error) {
      this.logger.warn({ slug: position.slug, error }, "Failed to cancel some exit orders");
    }
  }

  private buildCurrentSlug(prefix: string): string {
    const now = unixNow();
    const epoch = getCurrentEpochTimestamp(now, this.v5Config.marketIntervalSeconds);
    return `${prefix}-${epoch}`;
  }

  extractOrderId(result: unknown): string | null {
    if (!result || typeof result !== "object") return null;
    const record = result as Record<string, unknown>;

    if (record.dryRun === true) {
      return `dry-run-${Date.now()}`;
    }

    const orderId =
      record.orderId ??
      record.orderID ??
      record.id ??
      (record as { order?: { orderId?: string; orderID?: string; id?: string } }).order?.orderId ??
      (record as { order?: { orderId?: string; orderID?: string; id?: string } }).order?.orderID ??
      (record as { order?: { orderId?: string; orderID?: string; id?: string } }).order?.id;

    return typeof orderId === "string" ? orderId : null;
  }

  // ─── State persistence ───

  private async loadState(): Promise<void> {
    try {
      const content = await fs.readFile(this.v5Config.stateFilePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === "object" && "positions" in parsed) {
        this.state = parsed as V5State;
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        this.logger.warn({ error }, "Failed to load V5 state, starting fresh");
      }
      this.state = { positions: {} };
    }
  }

  private async saveState(): Promise<void> {
    try {
      const json = `${JSON.stringify(this.state, null, 2)}\n`;
      const parentDir = path.dirname(this.v5Config.stateFilePath);
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(this.v5Config.stateFilePath, json, "utf8");
    } catch (error) {
      this.logger.error({ error }, "Failed to save V5 state");
    }
  }

  private async appendTradeLog(entry: TradeLogEntry): Promise<void> {
    try {
      const logPath = "v5-trades.jsonl";
      const line = `${JSON.stringify(entry)}\n`;
      await fs.appendFile(logPath, line, "utf8");
    } catch (error) {
      this.logger.error({ error }, "Failed to append trade log");
    }
  }

  // ─── Telegram notifications ───

  private async notifyEntryFilled(position: V5Position): Promise<void> {
    const icon = position.favoriteSide === "up" ? "🟢" : "🔴";
    const message = [
      `<b>${icon} V5 Entry Filled</b>`,
      `<b>Market</b>: <code>${escapeHtml(position.slug)}</code>`,
      `<b>Side</b>: <code>${position.favoriteSide.toUpperCase()}</code>`,
      `<b>Size</b>: <code>${position.filledSize}</code>`,
      `<b>Entry</b>: <code>$${position.entryPrice.toFixed(2)}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-entry:${position.slug}`);
  }

  private async notifyPositionClosed(
    position: V5Position,
    reason: ExitReason,
    pnl: number,
  ): Promise<void> {
    const pnlIcon = pnl >= 0 ? "✅" : "❌";
    const reasonLabel = reason.replace(/_/g, " ").toUpperCase();
    const message = [
      `<b>${pnlIcon} V5 Position Closed — ${escapeHtml(reasonLabel)}</b>`,
      `<b>Market</b>: <code>${escapeHtml(position.slug)}</code>`,
      `<b>Side</b>: <code>${position.favoriteSide.toUpperCase()}</code>`,
      `<b>Entry</b>: <code>$${position.entryPrice.toFixed(2)}</code>`,
      `<b>PnL</b>: <code>${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-close:${position.slug}`);
  }

  private async notifyTrailingActivated(position: V5Position): Promise<void> {
    const message = [
      "<b>📈 V5 Trailing TP Activated</b>",
      `<b>Market</b>: <code>${escapeHtml(position.slug)}</code>`,
      `<b>HWM</b>: <code>$${position.highWaterMark.toFixed(2)}</code>`,
      `<b>Sell at</b>: <code>$${this.v5Config.trailingTpActivation.toFixed(2)}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-trailing:${position.slug}`);
  }

  private async notifyEntryError(slug: string, error: unknown): Promise<void> {
    const message = [
      "<b>❌ V5 Entry Failed</b>",
      `<b>Market</b>: <code>${escapeHtml(slug)}</code>`,
      `<b>Error</b>: <code>${escapeHtml(String(error instanceof Error ? error.message : error))}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-entry-error:${slug}`);
  }

  private async notifyExitError(
    slug: string,
    title: string,
    error: unknown,
  ): Promise<void> {
    const message = [
      `<b>❌ V5 ${escapeHtml(title)}</b>`,
      `<b>Market</b>: <code>${escapeHtml(slug)}</code>`,
      `<b>Error</b>: <code>${escapeHtml(String(error instanceof Error ? error.message : error))}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-exit-error:${slug}`);
  }
}
