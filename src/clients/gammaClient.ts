import { request } from "undici";
import type { BotConfig, MarketRecord } from "../types/domain.js";
import { withRetry } from "../utils/retry.js";

const buildMarketUrl = (baseUrl: string, slug: string): string => {
  const url = new URL("/markets", baseUrl);
  url.searchParams.set("slug", slug);
  url.searchParams.set("limit", "1");
  return url.toString();
};

export class GammaClient {
  constructor(private readonly config: BotConfig) {}

  async getMarketBySlug(slug: string): Promise<MarketRecord | null> {
    return withRetry(
      async () => {
        const url = buildMarketUrl(this.config.gammaApiBaseUrl, slug);
        const res = await request(url, {
          method: "GET",
          headersTimeout: this.config.requestTimeoutMs,
          bodyTimeout: this.config.requestTimeoutMs,
        });

        if (res.statusCode >= 400) {
          throw new Error(`Gamma error ${res.statusCode} for slug ${slug}`);
        }

        const payload = (await res.body.json()) as unknown;
        const items = Array.isArray(payload) ? payload : (payload as { data?: unknown }).data;

        if (!Array.isArray(items) || items.length === 0) {
          return null;
        }

        return items[0] as MarketRecord;
      },
      this.config.requestRetries,
      this.config.requestRetryBackoffMs,
    );
  }
}
