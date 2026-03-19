import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { V3PositionStore } from "../src/bot-v3/state/positionStore.js";

describe("bot v3 position store", () => {
  it("returns null when the state file does not exist", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pm-bot-v3-state-"));
    const store = new V3PositionStore(path.join(tempDir, "missing.json"));

    await expect(store.load()).resolves.toBeNull();

    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists and reloads the live position", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pm-bot-v3-state-"));
    const store = new V3PositionStore(path.join(tempDir, "state.json"));
    const position = {
      conditionId: "cond-1",
      slug: "sol-updown-5m-123",
      tokenId: "token-1",
      outcome: "Up",
      entryOrderId: "entry-1",
      exitOrderId: null,
      entryPrice: 0.86,
      targetPrice: 0.95,
      stopPrice: 0.75,
      status: "open" as const,
      openedAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };

    await store.save(position);

    const loaded = await store.load();
    expect(loaded).toEqual(position);

    await store.clear();
    expect(store.getLivePosition()).toBeNull();

    await rm(tempDir, { recursive: true, force: true });
  });
});
