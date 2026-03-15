import type { Logger } from "pino";
import { MarketSnapshotStore } from "../marketSnapshotStore.js";

export const requireFreshSnapshot = (params: {
  snapshotStore: MarketSnapshotStore;
  maxAgeMs: number;
  logger: Logger;
  taskName: string;
}): boolean => {
  if (!params.snapshotStore.isStale(params.maxAgeMs)) {
    return true;
  }

  params.logger.warn(
    { snapshotAgeMs: params.snapshotStore.getSnapshotAgeMs(), task: params.taskName },
    "Task skipped: stale market snapshot",
  );
  return false;
};
