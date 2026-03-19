import type { MarketRecord } from "../types/domain.js";

export interface V3Config {
  marketSlugPrefix: string;
  marketIntervalSeconds: number;
  entryThreshold: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  orderSize: number;
  maxEntryAsk: number;
  maxLivePositions: number;
  loopIntervalSeconds: number;
  orderFillTimeoutMs: number;
  orderFillPollIntervalMs: number;
  stateFilePath: string;
}

export interface V3MarketTokenQuote {
  tokenId: string;
  outcome: string;
  bestBid: number;
  bestAsk: number;
}

export interface V3MarketSnapshot {
  market: MarketRecord;
  slug: string;
  conditionId: string;
  secondsToClose: number | null;
  tokens: [V3MarketTokenQuote, V3MarketTokenQuote];
  fetchedAtMs: number;
}

export interface V3EntrySignal {
  conditionId: string;
  slug: string;
  tokenId: string;
  outcome: string;
  bestBid: number;
  bestAsk: number;
  secondsToClose: number | null;
}

export type V3PositionStatus = "open" | "awaiting_resolution" | "redeeming";

export interface V3LivePosition {
  conditionId: string;
  slug: string;
  tokenId: string;
  outcome: string;
  entryOrderId: string | null;
  exitOrderId: string | null;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  filledSize: number;
  status: V3PositionStatus;
  openedAtMs: number;
  updatedAtMs: number;
  lastExitReason?: "tp" | "sl";
}

export interface V3PersistedState {
  livePosition: V3LivePosition | null;
}

export interface V3OrderExecutionResult {
  orderId: string | null;
  filledSize: number;
  averagePrice: number;
}
