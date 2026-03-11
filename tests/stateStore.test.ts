import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/utils/stateStore.js";

describe("state store", () => {
  it("returns empty set when file does not exist", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pm-bot-state-"));
    const stateFilePath = path.join(tempDir, "missing-state.json");
    const store = new StateStore(stateFilePath);

    const tracked = await store.loadTrackedMarkets();
    expect(tracked.size).toBe(0);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists tracked markets and loads them back", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pm-bot-state-"));
    const stateFilePath = path.join(tempDir, "state.json");
    const store = new StateStore(stateFilePath);
    const original = new Set(["cond-a", "cond-b"]);

    await store.saveTrackedMarkets(original);

    const fileContent = await readFile(stateFilePath, "utf8");
    expect(fileContent.includes("cond-a")).toBe(true);

    const loaded = await store.loadTrackedMarkets();
    expect(Array.from(loaded).sort()).toEqual(["cond-a", "cond-b"]);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads legacy enteredMarkets state", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pm-bot-state-"));
    const stateFilePath = path.join(tempDir, "state.json");
    const store = new StateStore(stateFilePath);

    await writeFile(stateFilePath, `${JSON.stringify({ enteredMarkets: ["cond-a", "cond-b"] }, null, 2)}\n`, "utf8");

    const loaded = await store.loadTrackedMarkets();
    expect(Array.from(loaded).sort()).toEqual(["cond-a", "cond-b"]);

    await rm(tempDir, { recursive: true, force: true });
  });
});
