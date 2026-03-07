export type Side = "BUY" | "SELL";

export interface BotConfig {
  dryRun: boolean;
  enableLiveTrading: boolean;
  privateKey: `0x${string}`;
  funder?: `0x${string}`;
  signatureType: 0 | 1 | 2;
  chainId: 137 | 80002;
  clobApiHost: string;
  gammaApiBaseUrl: string;
  dataApiBaseUrl: string;
  polygonRpc?: string;
  polymarketRelayerUrl?: string;
  marketSlugPrefix: string;
  marketIntervalSeconds: number;
  orderPrice: number;
  orderSize: number;
  positionEqualityTolerance: number;
  forceSellThresholdSeconds: number;
  loopSleepSeconds: number;
  positionRecheckSeconds: number;
  requestTimeoutMs: number;
  requestRetries: number;
  requestRetryBackoffMs: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

export interface MarketToken {
  tokenId: string;
  outcome?: string;
}

export interface MarketRecord {
  id?: string;
  slug?: string;
  question?: string;
  conditionId?: string;
  condition_id?: string;
  clobTokenIds?: unknown;
  tokens?: unknown;
  endDate?: string;
  end_date_iso?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  [key: string]: unknown;
}

export interface TokenIds {
  upTokenId: string;
  downTokenId: string;
}

export interface PositionRecord {
  asset: string;
  conditionId: string;
  size: number;
  outcome?: string;
  redeemable?: boolean;
  mergeable?: boolean;
  endDate?: string;
  [key: string]: unknown;
}

export interface PositionSummary {
  upSize: number;
  downSize: number;
  differenceAbs: number;
}

export interface TradeIntent {
  action: "PLACE_LIMIT" | "PLACE_MARKET" | "CANCEL_ORDER" | "MERGE" | "REDEEM";
  payload: Record<string, unknown>;
}
