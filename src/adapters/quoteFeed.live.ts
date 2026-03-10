import { Effect, Layer } from "effect";
import { adapterError } from "../app/errors.js";
import { QuoteFeed, type QuoteFeed as QuoteFeedPort } from "../ports/QuoteFeed.js";
import { ClobWsClient } from "../clients/clobWsClient.js";

export const makeQuoteFeed = (client: ClobWsClient): QuoteFeedPort => ({
  start: Effect.try({
    try: () => {
      client.start();
    },
    catch: (cause) => adapterError({ adapter: "ClobWsClient", operation: "start", cause }),
  }),
  stop: Effect.try({
    try: () => {
      client.stop();
    },
    catch: (cause) => adapterError({ adapter: "ClobWsClient", operation: "stop", cause }),
  }),
  ensureSubscribed: (assetIds) =>
    Effect.try({
      try: () => {
        client.ensureSubscribed(assetIds);
      },
      catch: (cause) => adapterError({ adapter: "ClobWsClient", operation: "ensureSubscribed", cause }),
    }),
  getFreshQuote: (tokenId) =>
    Effect.try({
      try: () => client.getFreshQuote(tokenId),
      catch: (cause) => adapterError({ adapter: "ClobWsClient", operation: "getFreshQuote", cause }),
    }),
});

export const QuoteFeedLive = (client: ClobWsClient): Layer.Layer<QuoteFeedPort> => Layer.succeed(QuoteFeed, makeQuoteFeed(client));
