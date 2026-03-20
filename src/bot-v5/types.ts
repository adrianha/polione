export type PositionState = "entering" | "open" | "exiting" | "closed";

export type ExitReason = "take_profit" | "stop_loss" | "trailing_tp" | "market_resolved" | "manual";

export interface V5Position {
  conditionId: string;
  slug: string;
  tokenIds: { upTokenId: string; downTokenId: string };
  favoriteTokenId: string;
  favoriteSide: "up" | "down";
  entryPrice: number;
  size: number;
  filledSize: number;
  state: PositionState;
  highWaterMark: number;
  entryOrderId: string | null;
  trailingTpActivated: boolean;
  exitReason: ExitReason | null;
  filledAtMs: number | null;
  closedAtMs: number | null;
  createdAtMs: number;
}

export interface V5State {
  positions: Record<string, V5Position>;
}
