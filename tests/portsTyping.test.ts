import { describe, expect, it } from "vitest";
import { BotState } from "../src/ports/BotState.js";
import { Execution } from "../src/ports/Execution.js";
import { MarketData } from "../src/ports/MarketData.js";
import { Notifications } from "../src/ports/Notifications.js";
import { Positions } from "../src/ports/Positions.js";
import { QuoteFeed } from "../src/ports/QuoteFeed.js";
import { Settlement } from "../src/ports/Settlement.js";

describe("port tags", () => {
  it("exports all required service tags", () => {
    expect(MarketData).toBeDefined();
    expect(Execution).toBeDefined();
    expect(Positions).toBeDefined();
    expect(Settlement).toBeDefined();
    expect(Notifications).toBeDefined();
    expect(BotState).toBeDefined();
    expect(QuoteFeed).toBeDefined();
  });
});
