import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/bot-v2/runtime/scheduler.js";

describe("bot v2 scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs tasks according to interval and keeps cadence", async () => {
    vi.useFakeTimers();

    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
    } as any;

    const scheduler = new Scheduler(logger, 0.25);
    let fastRuns = 0;
    let slowRuns = 0;

    scheduler.register({
      name: "fast",
      intervalSeconds: 1,
      run: async () => {
        fastRuns += 1;
      },
    });
    scheduler.register({
      name: "slow",
      intervalSeconds: 2,
      run: async () => {
        slowRuns += 1;
      },
    });

    const runPromise = scheduler.runForever();

    setTimeout(() => {
      scheduler.stop();
    }, 3100);

    await vi.advanceTimersByTimeAsync(4000);
    await runPromise;

    expect(fastRuns).toBe(4);
    expect(slowRuns).toBe(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("isolates task errors and keeps other tasks running", async () => {
    vi.useFakeTimers();

    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
    } as any;

    const scheduler = new Scheduler(logger, 0.25);
    let healthyRuns = 0;

    scheduler.register({
      name: "broken",
      intervalSeconds: 1,
      run: async () => {
        throw new Error("broken task");
      },
    });
    scheduler.register({
      name: "healthy",
      intervalSeconds: 1,
      run: async () => {
        healthyRuns += 1;
      },
    });

    const runPromise = scheduler.runForever();

    setTimeout(() => {
      scheduler.stop();
    }, 2100);

    await vi.advanceTimersByTimeAsync(3000);
    await runPromise;

    expect(healthyRuns).toBeGreaterThanOrEqual(2);
    expect(logger.error).toHaveBeenCalled();
  });
});
