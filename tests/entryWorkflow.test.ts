import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runEntryLoopEffect } from "../src/workflows/entry.workflow.js";

describe("entry workflow", () => {
  it("processes entry and applies returned sleep interval", async () => {
    let iterations = 0;
    const sleeps: number[] = [];

    await Effect.runPromise(
      runEntryLoopEffect({
        isStopped: () => iterations >= 2,
        isSnapshotStale: () => false,
        getSnapshotAgeMs: () => 1,
        loopSleepSeconds: 10,
        sleep: async (seconds) => {
          sleeps.push(seconds);
        },
        resolveEntryConditionId: () => {
          iterations += 1;
          return "cond-1";
        },
        processEntry: async () => 3,
        withConditionLock: async (_conditionId, run) => ({ executed: true, result: await run() }),
        onDebug: async () => undefined,
        onWarn: async () => undefined,
        onError: async () => undefined,
      }),
    );

    expect(sleeps).toEqual([3, 3]);
  });
});
