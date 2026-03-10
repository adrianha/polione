import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runCurrentMarketLoopEffect } from "../src/workflows/currentMarket.workflow.js";

describe("current market workflow", () => {
  it("processes tracked condition and sleeps per loop", async () => {
    let iterations = 0;
    const calls: string[] = [];

    await Effect.runPromise(
      runCurrentMarketLoopEffect({
        isStopped: () => iterations >= 2,
        isSnapshotStale: () => false,
        getSnapshotAgeMs: () => 10,
        currentLoopSleepSeconds: 1,
        sleep: async () => {
          calls.push("sleep");
        },
        getCurrentMarketConditionId: () => "cond-1",
        isTrackedCondition: () => true,
        withConditionLock: async (_conditionId, run) => {
          iterations += 1;
          await run();
          return { executed: true };
        },
        processTrackedCurrentMarket: async () => {
          calls.push("process");
        },
        onDebug: async () => {
          calls.push("debug");
        },
        onWarn: async () => {
          calls.push("warn");
        },
        onError: async () => {
          calls.push("error");
        },
      }),
    );

    expect(calls).toEqual(["process", "sleep", "process", "sleep"]);
  });
});
