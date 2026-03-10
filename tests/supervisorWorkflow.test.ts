import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runSupervisorEffect } from "../src/workflows/supervisor.workflow.js";

describe("supervisor workflow", () => {
  it("starts all loop runners", async () => {
    const calls: string[] = [];

    await Effect.runPromise(
      runSupervisorEffect({
        runDiscovery: async () => {
          calls.push("discovery");
        },
        runCurrentMarket: async () => {
          calls.push("current");
        },
        runEntry: async () => {
          calls.push("entry");
        },
        runTelegram: async () => {
          calls.push("telegram");
        },
      }),
    );

    expect(calls.sort()).toEqual(["current", "discovery", "entry", "telegram"]);
  });
});
