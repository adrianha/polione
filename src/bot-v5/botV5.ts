import type { Logger } from "pino";
import type { BotConfig, MarketRecord, TokenIds } from "../types/domain.js";
import { GammaClient } from "../clients/gammaClient.js";
import { PolyClobClient } from "../clients/clobClient.js";
import { PolyRelayerClient } from "../clients/relayerClient.js";
import { DataClient } from "../clients/dataClient.js";
import { ClobWsClient } from "../clients/clobWsClient.js";
import { TelegramClient, escapeHtml, truncateId } from "../clients/telegramClient.js";
import { sleep, unixNow, getCurrentEpochTimestamp } from "../utils/time.js";
import { SettlementService } from "../services/settlement.js";
import { RedeemPrecheckService } from "../services/redeemPrecheck.js";
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
  private state: V5State = { positions: {}, consecutiveLosses: 0 };
  private lastRedeemRunMs = 0;

  private readonly gammaClient: GammaClient;
  private readonly clobClient: PolyClobClient;
  private readonly relayerClient: PolyRelayerClient;
  private readonly dataClient: DataClient;
  private readonly wsClient: ClobWsClient;
  private readonly telegramClient: TelegramClient;
  private readonly settlementService: SettlementService;
  private readonly redeemPrecheckService: RedeemPrecheckService;

  constructor(
    private readonly config: BotConfig,
    private readonly v5Config: V5Config,
    private readonly logger: Logger,
  ) {
    this.gammaClient = new GammaClient(config);
    this.clobClient = new PolyClobClient(config);
    this.relayerClient = new PolyRelayerClient(config);
    this.dataClient = new DataClient(config);
    this.wsClient = new ClobWsClient(config, logger);
    this.telegramClient = new TelegramClient({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
      logger,
    });
    this.settlementService = new SettlementService(this.relayerClient);
    this.redeemPrecheckService = new RedeemPrecheckService(config);
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
        slugPrefix: this.v5Config.slugPrefix,
        entryThreshold: this.v5Config.entryThreshold,
        maxEntryPrice: this.v5Config.maxEntryPrice,
        tpOffset: `$+${Math.abs(this.v5Config.takeProfitPrice - this.v5Config.entryThreshold).toFixed(2)}`,
        slOffset: `$-${Math.abs(this.v5Config.entryThreshold - this.v5Config.stopLossPrice).toFixed(2)}`,
        rrRatio: `${(Math.abs(this.v5Config.takeProfitPrice - this.v5Config.entryThreshold) / Math.abs(this.v5Config.entryThreshold - this.v5Config.stopLossPrice)).toFixed(1)}:1`,
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
    if (this.state.consecutiveLosses >= 3) {
      this.logger.fatal(
        { consecutiveLosses: this.state.consecutiveLosses },
        "3 consecutive losses detected, stopping bot",
      );
      await this.notifyMaxLossStreak();
      this.stop();
      return;
    }

    if (this.stopped) return;
    await this.processSlugPrefix(this.v5Config.slugPrefix);

    const now = Date.now();
    const redeemIntervalMs = this.v5Config.redeemIntervalSeconds * 1000;
    if (now - this.lastRedeemRunMs >= redeemIntervalMs) {
      this.lastRedeemRunMs = now;
      await this.processRedeemablePositions();
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

    const openCount = Object.entries(this.state.positions).filter(
      ([slug, p]) => slug.startsWith(prefix) && p.state !== "closed",
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

    let upQuote = this.wsClient.getFreshQuote(tokenIds.upTokenId);
    let downQuote = this.wsClient.getFreshQuote(tokenIds.downTokenId);

    // Fallback to REST API prices
    if (!upQuote || !downQuote) {
      const [upAsk, downAsk] = await Promise.all([
        this.clobClient.getPrice(tokenIds.upTokenId, "BUY"),
        this.clobClient.getPrice(tokenIds.downTokenId, "BUY"),
      ]);

      if (upAsk <= 0 || downAsk <= 0) {
        this.logger.warn(
          { slug, upAsk, downAsk },
          "REST price fallback also unavailable, skipping",
        );
        return;
      }

      upQuote = { bestAsk: upAsk, bestBid: upAsk };
      downQuote = { bestAsk: downAsk, bestBid: downAsk };
      this.logger.debug({ slug, upAsk, downAsk }, "Using REST prices as quotes");
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
      trailingTpActivated: false,
      exitReason: null,
      filledAtMs: null,
      closedAtMs: null,
      createdAtMs: Date.now(),
      redeemAttempts: 0,
    };

    this.state.positions[slug] = position;
    await this.saveState();

    this.logger.info(
      {
        slug,
        favoriteSide,
        favoriteTokenId,
        side: "BUY",
        amount: this.v5Config.maxUsdcPerTrade,
        price: roundPrice(estimatedPrice),
      },
      "Placing entry market order",
    );

    try {
      const result = await this.clobClient.placeMarketOrder({
        tokenId: favoriteTokenId,
        side: "BUY",
        amount: this.v5Config.maxUsdcPerTrade,
        price: roundPrice(estimatedPrice),
      });

      const orderError = this.extractOrderError(result);
      if (orderError) {
        this.logger.warn(
          { slug, favoriteSide, estimatedPrice, error: orderError, rawResult: result },
          "Entry market order rejected, no liquidity available",
        );
        position.state = "closed";
        position.closedAtMs = Date.now();
        await this.saveState();
        await this.notifyEntryRejected(slug, favoriteSide, estimatedPrice, orderError);
        return;
      }

      const entryOrderId = this.extractOrderId(result);
      position.entryOrderId = entryOrderId;

      this.logger.info(
        {
          slug,
          favoriteSide,
          estimatedPrice,
          maxUsdc: this.v5Config.maxUsdcPerTrade,
          entryOrderId,
        },
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
    const orderId = position.entryOrderId;

    // Market orders resolve immediately — check order status first
    if (orderId) {
      this.logger.info({ slug: position.slug, orderId }, "Checking entry order status");

      try {
        await sleep(0.5);
        const orderResult = await this.clobClient.getOrder(orderId);
        const orderStatus = this.parseOrderStatus(orderResult);

        this.logger.info(
          {
            slug: position.slug,
            orderId,
            status: orderStatus.status,
            filledSize: orderStatus.filledSize,
            orderResult,
          },
          "Entry order status",
        );

        const statusLower = orderStatus.status.toLowerCase();

        if (statusLower === "matched" || statusLower === "filled") {
          const filledSize = orderStatus.filledSize ?? position.size;
          const entryPrice = roundPrice(orderStatus.price ?? this.estimateEntryPrice(position));
          position.filledSize = filledSize;
          position.entryPrice = entryPrice;
          position.state = "open";
          position.filledAtMs = Date.now();
          position.highWaterMark = position.entryPrice;

          this.logger.info(
            {
              slug: position.slug,
              orderId,
              status: orderStatus.status,
              filledSize,
              entryPrice: position.entryPrice,
            },
            "Entry filled",
          );

          await this.saveState();
          await this.notifyEntryFilled(position);
          await this.placeExitOrders(position);
          return;
        }

        if (statusLower === "killed" || statusLower === "canceled" || statusLower === "cancelled") {
          this.logger.warn(
            { slug: position.slug, orderId, status: orderStatus.status },
            "Entry order not matched, killed by exchange",
          );
          position.state = "closed";
          position.closedAtMs = Date.now();
          await this.saveState();
          await this.notifyEntryFailed(position, "killed by exchange");
          return;
        }

        this.logger.debug(
          { slug: position.slug, orderId, status: orderStatus.status },
          "Order status not yet resolved, falling back to position polling",
        );
      } catch (error) {
        this.logger.debug(
          { slug: position.slug, orderId, error },
          "Failed to check order status, falling back to position polling",
        );
      }
    }

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

    this.logger.warn({ slug: position.slug, orderId }, "Entry fill timeout");
    position.state = "closed";
    position.closedAtMs = Date.now();
    await this.saveState();
    await this.notifyEntryFailed(position, "fill timeout");
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
    const slPrice = this.computeSlPrice(position.entryPrice);
    const tpPrice = this.computeTpPrice(position.entryPrice);

    this.logger.info(
      {
        slug: position.slug,
        entryPrice: position.entryPrice,
        tpPrice,
        slPrice,
        trailingTp: this.v5Config.trailingTp,
      },
      "Position open, monitoring for exit",
    );

    position.state = "exiting";
    await this.saveState();
  }

  private async managePosition(position: V5Position): Promise<void> {
    if (position.state === "entering") {
      return;
    }

    if (position.state === "closed") {
      return;
    }

    if (position.state === "awaiting_resolution" || position.state === "redeeming") {
      return;
    }

    if (position.state === "open") {
      await this.placeExitOrders(position);
      return;
    }

    // state === "exiting" — poll-based exit
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
      await this.exitPosition(position, "stop_loss", currentBid);
      return;
    }

    // Trailing TP mode
    if (this.v5Config.trailingTp) {
      if (!position.trailingTpActivated && position.highWaterMark >= tpPrice) {
        position.trailingTpActivated = true;
        this.logger.info(
          {
            slug: position.slug,
            entryPrice: position.entryPrice,
            hwm: position.highWaterMark,
            activationPrice: tpPrice,
          },
          "Trailing TP activated",
        );
        await this.saveState();
      }

      if (position.trailingTpActivated && currentBid <= tpPrice) {
        await this.exitPosition(position, "trailing_tp", currentBid);
        return;
      }
    }
    // Fixed TP mode
    else {
      if (currentBid >= tpPrice) {
        await this.exitPosition(position, "take_profit", currentBid);
        return;
      }
    }

    // Check if market is about to close
    const slugParts = position.slug.split("-");
    const epochStr = slugParts[slugParts.length - 1];
    const epoch = Number(epochStr);
    if (Number.isFinite(epoch)) {
      const endTime = epoch + this.v5Config.marketIntervalSeconds;
      const now = unixNow();
      if (now >= endTime - 10) {
        await this.exitPosition(position, "market_resolved", currentBid);
      }
    }
  }

  private async processRedeemablePositions(): Promise<void> {
    if (!this.v5Config.redeemEnabled) {
      return;
    }

    for (const position of Object.values(this.state.positions)) {
      if (this.stopped) break;
      if (position.state !== "awaiting_resolution") continue;

      await this.redeemPosition(position);
    }
  }

  private async redeemPosition(position: V5Position): Promise<void> {
    const { conditionId, slug } = position;

    if (position.redeemAttempts >= this.v5Config.redeemMaxRetries) {
      this.logger.warn(
        { slug, conditionId, redeemAttempts: position.redeemAttempts },
        "Max redeem retries exhausted, closing position",
      );
      position.state = "closed";
      position.exitReason = "redeemed";
      position.closedAtMs = Date.now();
      await this.saveState();
      await this.notifyRedeemFailed(slug, conditionId, "max retries exhausted");
      return;
    }

    if (this.config.dryRun) {
      this.logger.info({ slug, conditionId }, "[DRY RUN] Would redeem position");
      position.state = "closed";
      position.exitReason = "redeemed";
      position.closedAtMs = Date.now();
      await this.saveState();
      return;
    }

    // Precheck if eligible for redemption
    if (this.redeemPrecheckService.isAvailable()) {
      try {
        const precheck = await this.redeemPrecheckService.check({
          conditionId,
          positionsAddress: this.clobClient.getSignerAddress() as `0x${string}`,
        });

        this.logger.debug({ slug, conditionId, precheck }, "Redeem precheck result");

        if (precheck.status === "not_resolved") {
          this.logger.debug({ slug, conditionId }, "Condition not yet resolved, will retry");
          return;
        }

        if (precheck.status === "no_redeemable_balance") {
          this.logger.info({ slug, conditionId }, "No redeemable balance, closing position");
          position.state = "closed";
          position.exitReason = "redeemed";
          position.closedAtMs = Date.now();
          await this.saveState();
          return;
        }

        if (precheck.status === "permanent_error") {
          this.logger.error(
            { slug, conditionId, reason: precheck.reason },
            "Permanent error on redeem precheck, closing position",
          );
          position.state = "closed";
          position.exitReason = "redeemed";
          position.closedAtMs = Date.now();
          await this.saveState();
          await this.notifyRedeemFailed(slug, conditionId, precheck.reason ?? "permanent error");
          return;
        }
      } catch (error) {
        this.logger.warn({ slug, conditionId, error }, "Redeem precheck failed, will retry");
        return;
      }
    }

    // Submit redeem transaction
    position.state = "redeeming";
    position.redeemAttempts += 1;
    await this.saveState();

    this.logger.info(
      { slug, conditionId, attempt: position.redeemAttempts },
      "Submitting redeem transaction",
    );

    try {
      const result = await this.settlementService.redeemResolvedPositions(conditionId);

      if (result && "dryRun" in result) {
        this.logger.info({ slug, conditionId }, "[DRY RUN] Redeem submitted");
        position.state = "closed";
        position.exitReason = "redeemed";
        position.closedAtMs = Date.now();
        await this.saveState();
        return;
      }

      if (result === null) {
        this.logger.warn({ slug, conditionId }, "Relayer not available, will retry");
        position.state = "awaiting_resolution";
        await this.saveState();
        return;
      }

      this.logger.info(
        { slug, conditionId, attempt: position.redeemAttempts },
        "Redeem transaction submitted successfully",
      );
      position.state = "closed";
      position.exitReason = "redeemed";
      position.closedAtMs = Date.now();
      await this.saveState();
      await this.notifyRedeemSuccess(slug, conditionId);
    } catch (error) {
      this.logger.error({ slug, conditionId, error }, "Redeem transaction failed");
      position.state = "awaiting_resolution";
      await this.saveState();
    }
  }

  private async exitPosition(
    position: V5Position,
    reason: ExitReason,
    targetPrice: number,
  ): Promise<void> {
    if (this.config.dryRun) {
      await this.closePositionDryRun(position, reason, targetPrice);
      return;
    }

    this.logger.info(
      {
        slug: position.slug,
        favoriteSide: position.favoriteSide,
        favoriteTokenId: position.favoriteTokenId,
        side: "SELL",
        amount: position.filledSize,
        price: roundPrice(targetPrice),
        position,
      },
      "Placing exit market order",
    );

    try {
      const result = await this.clobClient.placeMarketOrder({
        tokenId: position.favoriteTokenId,
        side: "SELL",
        amount: position.filledSize,
        price: roundPrice(targetPrice),
      });

      const orderError = this.extractOrderError(result);
      if (orderError) {
        this.logger.warn(
          { slug: position.slug, reason, filledSize: position.filledSize, error: orderError },
          "Exit market sell rejected",
        );

        if (reason === "market_resolved" && this.v5Config.redeemEnabled) {
          this.logger.info(
            { slug: position.slug },
            "Market sell failed at resolution, transitioning to awaiting_resolution",
          );
          position.state = "awaiting_resolution";
          position.exitReason = reason;
          await this.saveState();
          return;
        }
      } else {
        this.logger.info(
          { slug: position.slug, reason, filledSize: position.filledSize, targetPrice },
          "Exit market sell placed",
        );
      }
    } catch (error) {
      this.logger.error({ slug: position.slug, reason, error }, "Exit market sell failed");

      if (reason === "market_resolved" && this.v5Config.redeemEnabled) {
        this.logger.info(
          { slug: position.slug },
          "Market sell failed at resolution, transitioning to awaiting_resolution",
        );
        position.state = "awaiting_resolution";
        position.exitReason = reason;
        await this.saveState();
        return;
      }
    }

    await this.closePosition(position, reason);
  }

  private computeTpPrice(entryPrice: number): number {
    const offset = Math.abs(this.v5Config.takeProfitPrice - this.v5Config.entryThreshold);
    return roundPrice(Math.min(0.99, entryPrice + offset));
  }

  private computeSlPrice(entryPrice: number): number {
    const offset = Math.abs(this.v5Config.entryThreshold - this.v5Config.stopLossPrice);
    return roundPrice(Math.max(0, entryPrice - offset));
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

    if (pnl < 0) {
      this.state.consecutiveLosses += 1;
    } else {
      this.state.consecutiveLosses = 0;
    }

    const pnlPct =
      position.entryPrice > 0
        ? roundPrice((exitPrice - position.entryPrice) / position.entryPrice)
        : 0;
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

    const pnl = this.estimatePnl(position);

    if (pnl < 0) {
      this.state.consecutiveLosses += 1;
      this.logger.warn(
        { slug: position.slug, consecutiveLosses: this.state.consecutiveLosses },
        "Loss detected, incrementing consecutive loss counter",
      );
    } else {
      this.state.consecutiveLosses = 0;
    }

    await this.saveState();

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

  extractOrderError(result: unknown): string | null {
    if (!result || typeof result !== "object") return null;
    const record = result as Record<string, unknown>;

    if (record.dryRun === true) return null;

    // Check for HTTP error status
    const status = record.status;
    if (typeof status === "number" && status >= 400) {
      // Try various paths for the error message
      const data = record.data as Record<string, unknown> | undefined;
      const responseData = record.response
        ? ((record.response as Record<string, unknown>).data as Record<string, unknown> | undefined)
        : undefined;

      const errorMsg = data?.error ?? responseData?.error ?? record.statusText ?? record.error;

      return typeof errorMsg === "string" ? errorMsg : `HTTP ${status}`;
    }

    if (record.error && typeof record.error === "string") {
      return record.error;
    }

    return null;
  }

  private parseOrderStatus(result: unknown): {
    status: string;
    filledSize?: number;
    price?: number;
  } {
    if (!result || typeof result !== "object") {
      return { status: "unknown" };
    }

    const record = result as Record<string, unknown>;

    // Polymarket CLOB returns order status in various shapes
    const status =
      (record.status as string | undefined) ??
      ((record.order as Record<string, unknown> | undefined)?.status as string | undefined);

    const filledSize =
      (record.filledSize as number | undefined) ??
      (record.size_matched !== undefined ? Number(record.size_matched) : undefined) ??
      (record.takingAmount as number | undefined) ??
      ((record.order as Record<string, unknown> | undefined)?.filledSize as number | undefined);

    const price =
      (record.price as number | string | undefined) !== undefined
        ? Number(record.price)
        : undefined;

    return {
      status: status ?? "unknown",
      filledSize: filledSize ? Number(filledSize) : undefined,
      price: price && price > 0 ? price : undefined,
    };
  }

  // ─── State persistence ───

  private async loadState(): Promise<void> {
    try {
      const content = await fs.readFile(this.v5Config.stateFilePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === "object" && "positions" in parsed) {
        this.state = parsed as V5State;
        if (typeof this.state.consecutiveLosses !== "number") {
          this.state.consecutiveLosses = 0;
        }
        for (const position of Object.values(this.state.positions)) {
          if (typeof position.redeemAttempts !== "number") {
            position.redeemAttempts = 0;
          }
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        this.logger.warn({ error }, "Failed to load V5 state, starting fresh");
      }
      this.state = { positions: {}, consecutiveLosses: 0 };
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

  private async notifyEntryError(slug: string, error: unknown): Promise<void> {
    const message = [
      "<b>❌ V5 Entry Failed</b>",
      `<b>Market</b>: <code>${escapeHtml(slug)}</code>`,
      `<b>Error</b>: <code>${escapeHtml(String(error instanceof Error ? error.message : error))}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-entry-error:${slug}`);
  }

  private async notifyEntryRejected(
    slug: string,
    favoriteSide: "up" | "down",
    estimatedPrice: number,
    reason: string,
  ): Promise<void> {
    const icon = favoriteSide === "up" ? "🟢" : "🔴";
    const message = [
      `<b>${icon} V5 Entry Rejected</b>`,
      `<b>Market</b>: <code>${escapeHtml(slug)}</code>`,
      `<b>Side</b>: <code>${favoriteSide.toUpperCase()}</code>`,
      `<b>Price</b>: <code>${estimatedPrice}</code>`,
      `<b>Reason</b>: <code>${escapeHtml(reason)}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-entry-rejected:${slug}`);
  }

  private async notifyEntryFailed(position: V5Position, reason: string): Promise<void> {
    const icon = position.favoriteSide === "up" ? "🟢" : "🔴";
    const message = [
      `<b>${icon} V5 Entry Failed</b>`,
      `<b>Market</b>: <code>${escapeHtml(position.slug)}</code>`,
      `<b>Side</b>: <code>${position.favoriteSide.toUpperCase()}</code>`,
      `<b>Order</b>: <code>${escapeHtml(truncateId(position.entryOrderId ?? "n/a"))}</code>`,
      `<b>Reason</b>: <code>${escapeHtml(reason)}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-entry-failed:${position.slug}`);
  }

  private async notifyMaxLossStreak(): Promise<void> {
    const message = [
      "<b>🛑 V5 Bot Stopped</b>",
      `<b>Reason</b>: <code>${this.state.consecutiveLosses} consecutive losses</code>`,
      "<b>Action</b>: <code>Manual restart required</code>",
    ].join("\n");

    await this.telegramClient.sendHtml(message, "v5-max-loss");
  }

  private async notifyRedeemSuccess(slug: string, conditionId: string): Promise<void> {
    const message = [
      "<b>✅ V5 Position Redeemed</b>",
      `<b>Market</b>: <code>${escapeHtml(slug)}</code>`,
      `<b>Condition</b>: <code>${escapeHtml(truncateId(conditionId))}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-redeem:${slug}`);
  }

  private async notifyRedeemFailed(
    slug: string,
    conditionId: string,
    reason: string,
  ): Promise<void> {
    const message = [
      "<b>❌ V5 Redeem Failed</b>",
      `<b>Market</b>: <code>${escapeHtml(slug)}</code>`,
      `<b>Condition</b>: <code>${escapeHtml(truncateId(conditionId))}</code>`,
      `<b>Reason</b>: <code>${escapeHtml(reason)}</code>`,
    ].join("\n");

    await this.telegramClient.sendHtml(message, `v5-redeem-fail:${slug}`);
  }
}
