import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runDiscoveryLoopEffect } from "../src/workflows/discovery.workflow.js";

describe("discovery workflow", () => {
  it("updates snapshot and sleeps until stopped", async () => {
    let iterations = 0;
    const calls: string[] = [];

    await Effect.runPromise(
      runDiscoveryLoopEffect({
        loopSleepSeconds: 1,
        isStopped: () => iterations >= 2,
        updateSnapshot: async () => {
          calls.push("update");
          iterations += 1;
        },
        onError: async () => {
          calls.push("error");
        },
        sleep: async () => {
          calls.push("sleep");
        },
      }),
    );

    expect(calls).toEqual(["update", "sleep", "update", "sleep"]);
  });
});
