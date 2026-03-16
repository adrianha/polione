import type { Logger } from "pino";
import type {
  BotConfig,
  MarketRecord,
  PositionSummary,
  RedeemStateRecord,
  TokenIds,
} from "../types/domain.js";
import type { PolyClobClient } from "../clients/clobClient.js";
import type { DataClient } from "../clients/dataClient.js";
import type { GammaClient } from "../clients/gammaClient.js";
import type { PolyRelayerClient } from "../clients/relayerClient.js";
import type { TelegramClient } from "../clients/telegramClient.js";
import type { MarketDiscoveryService } from "../services/marketDiscovery.js";
import type { RedeemPrecheckService } from "../services/redeemPrecheck.js";
import type { SettlementService } from "../services/settlement.js";
import type { TradingEngine } from "../services/tradingEngine.js";
import type { StateStore } from "../utils/stateStore.js";
import type {
  ConditionLifecycle,
  ConditionRuntimeState,
  CurrentMarketResult,
  EntryOpportunityResult,
  MarketContext,
  MarketTaskSignal,
  RecoveryPlacementRecord,
} from "./marketFlowTypes.js";

export type BotRuntimeDependencies = {
  config: BotConfig;
  logger: Logger;
  gammaClient: GammaClient;
  clobClient: PolyClobClient;
  relayerClient: PolyRelayerClient;
  dataClient: DataClient;
  marketDiscovery: MarketDiscoveryService;
  tradingEngine: TradingEngine;
  settlementService: SettlementService;
  redeemPrecheckService: RedeemPrecheckService;
  telegramClient: TelegramClient;
  stateStore: StateStore;
};

export type BotRuntimeState = {
  stopped: boolean;
  conditionStates: Map<string, ConditionRuntimeState>;
  redeemStates: Map<string, RedeemStateRecord>;
  trackedMarkets: Set<string>;
  recentRecoveryPlacements: Map<string, RecoveryPlacementRecord>;
  inFlightConditions: Set<string>;
  relayerFailoverActive: boolean;
  activeCurrentConditionId: string | null;
  activeCurrentTokenIds: TokenIds | null;
  telegramOffset: number | undefined;
};

export type NotificationPort = {
  formatTelegramMessage(params: {
    title: string;
    severity: "warn" | "error" | "info";
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    details: Array<{ key: string; value: string | number | null | undefined }>;
  }): string;
  notify(params: {
    title: string;
    severity: "warn" | "error" | "info";
    dedupeKey: string;
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    details: Array<{ key: string; value: string | number | null | undefined }>;
  }): Promise<void>;
  notifyOperationalIssue(params: {
    title: string;
    severity: "warn" | "error";
    dedupeKey: string;
    slug?: string;
    conditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    error?: unknown;
    details?: Array<{ key: string; value: string | number | null | undefined }>;
  }): Promise<void>;
  notifyPlacementSuccessOnce(params: {
    conditionId: string;
    slug?: string;
    upTokenId: string;
    downTokenId: string;
    entryPrice: number;
    orderSize: number;
    attempt: number;
    secondsToClose?: number | null;
    mode: "current-market" | "non-current-market";
  }): Promise<void>;
  notifyEntryFilledOnce(params: {
    conditionId: string;
    slug?: string;
    upTokenId: string;
    downTokenId: string;
    upSize: number;
    downSize: number;
    entryPrice?: number;
    filledLegAvgPrice?: number;
    mode: "reconcile" | "continuous-recovery" | "force-window";
  }): Promise<void>;
  normalizeError(error: unknown): string;
};

export type RuntimeStatePort = {
  getConditionState(conditionId: string): ConditionRuntimeState;
  patchConditionState(
    conditionId: string,
    patch: Partial<ConditionRuntimeState>,
  ): ConditionRuntimeState;
  markTrackedMarket(conditionId: string): Promise<void>;
  transitionConditionLifecycle(conditionId: string, state: ConditionLifecycle): void;
  loadPersistedTrackedMarkets(): Promise<void>;
};

export type MarketFlowPort = {
  noteCurrentMarketContext(conditionId: string, tokenIds: TokenIds): void;
  runContinuousMissingLegRecovery(params: {
    market: MarketRecord;
    conditionId: string;
    positionsAddress: string;
    tokenIds: TokenIds;
    currentSummary: PositionSummary;
    filledLegAvgPrice: number;
    previousPlacement?: RecoveryPlacementRecord;
  }): Promise<unknown>;
  handleForceWindowImbalance(params: {
    market: MarketRecord;
    conditionId: string;
    positionsAddress: string;
    tokenIds: TokenIds;
    summary: PositionSummary;
    secondsToClose: number | null;
    entryPrice: number;
  }): Promise<{ status: "balanced" | "imbalanced" | "failed" }>;
  processTrackedCurrentMarket(params: {
    currentMarket: MarketRecord;
    currentConditionId: string;
    positionsAddress: string;
  }): Promise<CurrentMarketResult>;
  selectEntryMarket(params: MarketContext): MarketRecord | null;
  processEntryMarket(params: {
    entryMarket: MarketRecord;
    currentConditionId: string | null;
    positionsAddress: string;
  }): Promise<EntryOpportunityResult>;
  discoverMarketContext(): Promise<MarketContext>;
  computeNextMarketInterval(signal: MarketTaskSignal): number;
  runMarketTask(positionsAddress: string): Promise<MarketTaskSignal>;
};

export type RuntimeControlPort = {
  stop(): void;
  withConditionLock<T>(
    conditionId: string,
    run: () => Promise<T>,
  ): Promise<{ executed: boolean; result?: T }>;
  cancelEntryOrdersAfterBalance(
    tokenIds: TokenIds,
    context: { conditionId: string; path: string },
  ): Promise<boolean>;
  getRelayerMeta(result: unknown): { builderLabel?: string; failoverFrom?: string } | null;
  maybeNotifyRelayerFailover(params: {
    action: unknown;
    slug?: string;
    conditionId: string;
    upTokenId?: string;
    downTokenId?: string;
  }): Promise<void>;
  runRedeemTask(positionsAddress: string): Promise<void>;
  runTelegramTask(): Promise<void>;
  runForever(): Promise<void>;
};

export type BotDomainContext = BotRuntimeDependencies &
  BotRuntimeState &
  NotificationPort &
  RuntimeStatePort &
  MarketFlowPort &
  RuntimeControlPort;
