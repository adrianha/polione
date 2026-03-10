import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { makeQuoteFeed } from "../src/adapters/quoteFeed.live.js";

describe("effect adapter: quote feed", () => {
  it("maps ws client methods to effect operations", async () => {
    const client = {
      start: vi.fn(),
      stop: vi.fn(),
      ensureSubscribed: vi.fn(),
      getFreshQuote: vi.fn(() => ({ bestBid: 0.45, bestAsk: 0.46 })),
    };

    const adapter = makeQuoteFeed(client as never);
    await Effect.runPromise(adapter.start);
    await Effect.runPromise(adapter.ensureSubscribed(["token-1"]));
    const quote = await Effect.runPromise(adapter.getFreshQuote("token-1"));
    await Effect.runPromise(adapter.stop);

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.ensureSubscribed).toHaveBeenCalledWith(["token-1"]);
    expect(quote).toEqual({ bestBid: 0.45, bestAsk: 0.46 });
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects empty subscription lists", async () => {
    const client = {
      start: vi.fn(),
      stop: vi.fn(),
      ensureSubscribed: vi.fn(),
      getFreshQuote: vi.fn(() => null),
    };

    const adapter = makeQuoteFeed(client as never);
    await expect(Effect.runPromise(adapter.ensureSubscribed([]))).rejects.toThrow();
  });
});
