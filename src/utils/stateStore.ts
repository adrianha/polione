import { promises as fs } from "node:fs";
import path from "node:path";

interface PersistedState {
  trackedMarkets: string[];
}

const defaultState = (): PersistedState => ({
  trackedMarkets: [],
});

const normalizeState = (value: unknown): PersistedState => {
  if (!value || typeof value !== "object") {
    return defaultState();
  }

  const raw = value as { trackedMarkets?: unknown; enteredMarkets?: unknown };
  const candidate = Array.isArray(raw.trackedMarkets)
    ? raw.trackedMarkets
    : Array.isArray(raw.enteredMarkets)
      ? raw.enteredMarkets
      : null;
  if (!candidate) {
    return defaultState();
  }

  const trackedMarkets = candidate.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );

  return { trackedMarkets: Array.from(new Set(trackedMarkets)) };
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
    const state: PersistedState = {
      trackedMarkets: Array.from(trackedMarkets),
    };
    const json = `${JSON.stringify(state, null, 2)}\n`;

    const parentDir = path.dirname(this.filePath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(this.filePath, json, "utf8");
  }
}
