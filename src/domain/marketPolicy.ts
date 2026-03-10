export const getSnapshotAgeMs = (snapshotUpdatedAtMs: number | null, nowMs = Date.now()): number | null => {
  if (snapshotUpdatedAtMs === null) {
    return null;
  }

  return nowMs - snapshotUpdatedAtMs;
};

export const isSnapshotStale = (params: {
  snapshotUpdatedAtMs: number | null;
  loopSleepSeconds: number;
  nowMs?: number;
}): boolean => {
  const ageMs = getSnapshotAgeMs(params.snapshotUpdatedAtMs, params.nowMs);
  if (ageMs === null) {
    return true;
  }

  const maxAgeMs = Math.max(params.loopSleepSeconds, 1) * 2000;
  return ageMs > maxAgeMs;
};
