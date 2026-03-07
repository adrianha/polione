import { promises as fs } from "node:fs";
import path from "node:path";

interface PersistedState {
  enteredMarkets: string[];
}

const defaultState = (): PersistedState => ({
  enteredMarkets: []
});

const normalizeState = (value: unknown): PersistedState => {
  if (!value || typeof value !== "object") {
    return defaultState();
  }

  const raw = value as { enteredMarkets?: unknown };
  if (!Array.isArray(raw.enteredMarkets)) {
    return defaultState();
  }

  const enteredMarkets = raw.enteredMarkets
    .filter((item): item is string => typeof item === "string" && item.length > 0);

  return { enteredMarkets: Array.from(new Set(enteredMarkets)) };
};

export class StateStore {
  constructor(private readonly filePath: string) {}

  async loadEnteredMarkets(): Promise<Set<string>> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      const state = normalizeState(parsed);
      return new Set(state.enteredMarkets);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return new Set<string>();
      }
      throw error;
    }
  }

  async saveEnteredMarkets(enteredMarkets: Set<string>): Promise<void> {
    const state: PersistedState = {
      enteredMarkets: Array.from(enteredMarkets)
    };
    const json = `${JSON.stringify(state, null, 2)}\n`;

    const parentDir = path.dirname(this.filePath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(this.filePath, json, "utf8");
  }
}
