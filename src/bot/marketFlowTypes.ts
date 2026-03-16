import type { MarketRecord, PositionSummary } from "../types/domain.js";

export type ConditionLifecycle =
  | "new"
  | "entry-pending"
  | "recovery-pending"
  | "force-window"
  | "balanced"
  | "terminal";

export type EntryOpportunityOutcome =
  | "idle"
  | "entered"
  | "balanced"
  | "recovery-needed"
  | "force-window"
  | "failed";

export type CurrentMarketOutcome =
  | "idle"
  | "balanced"
  | "recovery-needed"
  | "recovery-placed"
  | "force-window"
  | "failed";

export type MarketTaskOutcome =
  | "idle"
  | "entered"
  | "balanced"
  | "recovery-needed"
  | "recovery-placed"
  | "force-window"
  | "failed";

export type EntryOpportunityResult = {
  outcome: EntryOpportunityOutcome;
  conditionId?: string;
  secondsToClose: number | null;
};

export type CurrentMarketResult = {
  outcome: CurrentMarketOutcome;
  hasTrackedExposure: boolean;
  secondsToClose: number | null;
};

export type MarketTaskSignal = {
  outcome: MarketTaskOutcome;
  hasTrackedExposure: boolean;
  secondsToClose: number | null;
};

export type MarketContext = {
  currentMarket: MarketRecord | null;
  nextMarket: MarketRecord | null;
  currentConditionId: string | null;
};

export type RecoveryPlacementRecord = {
  placedAtMs: number;
  summary: PositionSummary;
  missingLegTokenId: string;
  price: number;
  placedSize: number;
  orderId: string | null;
};

export type ConditionRuntimeState = {
  tracked: boolean;
  lifecycle: ConditionLifecycle;
  mergeAttempted: boolean;
  balancedCleanupDone: boolean;
  balancedChecks: number;
  recoveryPlacement?: RecoveryPlacementRecord;
  placementNotified: boolean;
  filledNotified: boolean;
};
