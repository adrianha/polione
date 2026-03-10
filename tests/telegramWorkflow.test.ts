import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runTelegramLoopEffect } from "../src/workflows/telegram.workflow.js";

describe("telegram workflow", () => {
  it("processes commands and sleeps at minimum interval", async () => {
    let iterations = 0;
    const calls: string[] = [];

    await Effect.runPromise(
      runTelegramLoopEffect({
        isStopped: () => iterations >= 2,
        loopSleepSeconds: 1,
        processCommands: async () => {
          iterations += 1;
          calls.push("process");
        },
        onWarn: async () => {
          calls.push("warn");
        },
        sleep: async (seconds) => {
          calls.push(`sleep:${seconds}`);
        },
      }),
    );

    expect(calls).toEqual(["process", "sleep:2", "process", "sleep:2"]);
  });
});
