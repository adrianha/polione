import { promises as fs } from "node:fs";
import path from "node:path";
import type { V3LivePosition, V3PersistedState } from "../types.js";

const defaultState = (): V3PersistedState => ({
  livePosition: null,
});

const isLivePosition = (value: unknown): value is V3LivePosition => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<V3LivePosition>;
  return (
    typeof candidate.conditionId === "string" &&
    typeof candidate.slug === "string" &&
    typeof candidate.tokenId === "string" &&
    typeof candidate.outcome === "string" &&
    typeof candidate.entryPrice === "number" &&
    Number.isFinite(candidate.entryPrice) &&
    typeof candidate.targetPrice === "number" &&
    Number.isFinite(candidate.targetPrice) &&
    typeof candidate.stopPrice === "number" &&
    Number.isFinite(candidate.stopPrice) &&
    ["open", "awaiting_resolution", "redeeming"].includes(String(candidate.status)) &&
    typeof candidate.openedAtMs === "number" &&
    Number.isFinite(candidate.openedAtMs) &&
    typeof candidate.updatedAtMs === "number" &&
    Number.isFinite(candidate.updatedAtMs)
  );
};

const normalizeState = (value: unknown): V3PersistedState => {
  if (!value || typeof value !== "object") {
    return defaultState();
  }

  const raw = value as { livePosition?: unknown };
  return {
    livePosition: isLivePosition(raw.livePosition) ? raw.livePosition : null,
  };
};

export class V3PositionStore {
  private livePosition: V3LivePosition | null = null;

  constructor(private readonly filePath: string) {}

  async load(): Promise<V3LivePosition | null> {
    const state = await this.readState();
    this.livePosition = state.livePosition;
    return this.livePosition;
  }

  getLivePosition(): V3LivePosition | null {
    return this.livePosition;
  }

  async save(position: V3LivePosition): Promise<void> {
    this.livePosition = position;
    await this.writeState({ livePosition: position });
  }

  async clear(): Promise<void> {
    this.livePosition = null;
    await this.writeState(defaultState());
  }

  private async readState(): Promise<V3PersistedState> {
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

  private async writeState(state: V3PersistedState): Promise<void> {
    const parentDir = path.dirname(this.filePath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
