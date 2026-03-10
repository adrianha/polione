import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { makeFileBotState } from "../src/adapters/stateStore.file.live.js";
import { makeTelegramNotifications } from "../src/adapters/telegramNotifications.live.js";

describe("effect adapters: state + telegram", () => {
  it("maps state store operations to effects", async () => {
    const store = {
      loadTrackedMarkets: vi.fn(async () => new Set(["cond-1"])),
      saveTrackedMarkets: vi.fn(async () => undefined),
    };

    const adapter = makeFileBotState(store as never);
    const loaded = await Effect.runPromise(adapter.loadTrackedMarkets);

    expect(Array.from(loaded)).toEqual(["cond-1"]);

    await Effect.runPromise(adapter.saveTrackedMarkets(new Set(["cond-2"])));
    expect(store.saveTrackedMarkets).toHaveBeenCalledTimes(1);
  });

  it("formats and sends telegram notification through effect port", async () => {
    const client = {
      sendHtml: vi.fn(async () => undefined),
    };

    const adapter = makeTelegramNotifications(client as never);
    await Effect.runPromise(
      adapter.send({
        title: "Bot started",
        severity: "info",
        dedupeKey: "start:1",
        slug: "btc-updown-5m-1",
        conditionId: "0xabcdef1234567890",
        details: [{ key: "mode", value: "SAFE" }],
      }),
    );

    expect(client.sendHtml).toHaveBeenCalledTimes(1);
    const [message, dedupeKey] = client.sendHtml.mock.calls[0] as unknown as [string, string];
    expect(message).toContain("Bot started");
    expect(message).toContain("Market");
    expect(dedupeKey).toBe("start:1");
  });
});
