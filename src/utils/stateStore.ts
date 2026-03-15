import { promises as fs } from "node:fs";
import path from "node:path";
import type { RedeemStateRecord } from "../types/domain.js";

interface PersistedState {
  trackedMarkets: string[];
  redeemStates: Record<string, RedeemStateRecord>;
}

const defaultState = (): PersistedState => ({
  trackedMarkets: [],
  redeemStates: {},
});

const isRedeemStateRecord = (value: unknown): value is RedeemStateRecord => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RedeemStateRecord>;
  const validStatus = ["pending", "eligible", "submitted", "terminal"].includes(
    String(candidate.status),
  );
  const validAttempts =
    typeof candidate.attempts === "number" &&
    Number.isInteger(candidate.attempts) &&
    candidate.attempts >= 0;
  const validNextRetryAt =
    typeof candidate.nextRetryAtMs === "number" && Number.isFinite(candidate.nextRetryAtMs);
  const validUpdatedAt =
    typeof candidate.updatedAtMs === "number" && Number.isFinite(candidate.updatedAtMs);

  return validStatus && validAttempts && validNextRetryAt && validUpdatedAt;
};

const normalizeState = (value: unknown): PersistedState => {
  if (!value || typeof value !== "object") {
    return defaultState();
  }

  const raw = value as {
    trackedMarkets?: unknown;
    enteredMarkets?: unknown;
    redeemStates?: unknown;
  };
  const candidate = Array.isArray(raw.trackedMarkets)
    ? raw.trackedMarkets
    : Array.isArray(raw.enteredMarkets)
      ? raw.enteredMarkets
      : null;
  const redeemStates: Record<string, RedeemStateRecord> = {};
  if (raw.redeemStates && typeof raw.redeemStates === "object") {
    for (const [conditionId, state] of Object.entries(
      raw.redeemStates as Record<string, unknown>,
    )) {
      if (typeof conditionId === "string" && conditionId.length > 0 && isRedeemStateRecord(state)) {
        redeemStates[conditionId] = state;
      }
    }
  }

  if (!candidate) {
    return {
      trackedMarkets: [],
      redeemStates,
    };
  }

  const trackedMarkets = candidate.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );

  return {
    trackedMarkets: Array.from(new Set(trackedMarkets)),
    redeemStates,
  };
};

export class StateStore {
  constructor(private readonly filePath: string) {}

  async loadTrackedMarkets(): Promise<Set<string>> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      const state = normalizeState(parsed);
      return new Set(state.trackedMarkets);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return new Set<string>();
      }
      throw error;
    }
  }

  async saveTrackedMarkets(trackedMarkets: Set<string>): Promise<void> {
    const existing = await this.loadState();
    const state: PersistedState = {
      trackedMarkets: Array.from(trackedMarkets),
      redeemStates: existing.redeemStates,
    };
    await this.saveState(state);
  }

  async loadRedeemStates(): Promise<Map<string, RedeemStateRecord>> {
    const state = await this.loadState();
    return new Map(Object.entries(state.redeemStates));
  }

  async saveRedeemStates(redeemStates: Map<string, RedeemStateRecord>): Promise<void> {
    const existing = await this.loadState();
    const state: PersistedState = {
      trackedMarkets: existing.trackedMarkets,
      redeemStates: Object.fromEntries(redeemStates.entries()),
    };
    await this.saveState(state);
  }

  private async loadState(): Promise<PersistedState> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      return normalizeState(JSON.parse(content) as unknown);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return defaultState();
      }
      throw error;
    }
  }

  private async saveState(state: PersistedState): Promise<void> {
    const json = `${JSON.stringify(state, null, 2)}\n`;

    const parentDir = path.dirname(this.filePath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(this.filePath, json, "utf8");
  }
}
