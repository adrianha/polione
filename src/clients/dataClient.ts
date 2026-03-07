import { request } from "undici";
import type { BotConfig, PositionRecord } from "../types/domain.js";
import { withRetry } from "../utils/retry.js";

const normalizeAddress = (address: string): string => address.toLowerCase();

export class DataClient {
  constructor(private readonly config: BotConfig) {}

  async getPositions(userAddress: string, conditionId?: string): Promise<PositionRecord[]> {
    return withRetry(async () => {
      const url = new URL("/positions", this.config.dataApiBaseUrl);
      url.searchParams.set("user", normalizeAddress(userAddress));
      url.searchParams.set("sizeThreshold", "0");
      url.searchParams.set("limit", "500");
      if (conditionId) {
        url.searchParams.set("market", conditionId);
      }

      const res = await request(url.toString(), {
        method: "GET",
        headersTimeout: this.config.requestTimeoutMs,
        bodyTimeout: this.config.requestTimeoutMs
      });

      if (res.statusCode >= 400) {
        throw new Error(`Data API error ${res.statusCode}`);
      }

      const payload = (await res.body.json()) as unknown;
      if (!Array.isArray(payload)) {
        return [];
      }

      return payload as PositionRecord[];
    }, this.config.requestRetries, this.config.requestRetryBackoffMs);
  }
}
