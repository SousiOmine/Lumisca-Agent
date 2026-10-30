/**
 * Perplexity Search API: search only (pages are fetched directly).
 * Search: https://api.perplexity.ai/search
 *
 * Authenticated with `Authorization: Bearer <key>`. This is the ranking
 * endpoint, not chat completions: it returns results and generates nothing.
 */

import { SEARCH_TIMEOUT_MS } from "../constants.ts";
import { requestJson } from "../http.ts";
import type { ProviderAdapter } from "../types.ts";
import {
  arrayOf,
  firstOrNull,
  numberLimit,
  snippetOf,
  stringOf,
} from "./helpers.ts";

const SEARCH_URL = "https://api.perplexity.ai/search";

export const perplexity: ProviderAdapter = {
  id: "perplexity",
  name: "Perplexity",
  supportsFetch: false,

  async search(context, request) {
    const json = await requestJson(
      context.fetch,
      SEARCH_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${context.apiKey}`,
        },
        body: JSON.stringify({
          query: request.query,
          max_results: numberLimit(request.limit),
        }),
      },
      {
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: request.signal,
        provider: "Perplexity",
      },
    );

    return {
      results: arrayOf(json, "results")
        .map((item) => ({
          title: stringOf(item["title"], "(untitled)"),
          url: stringOf(item["url"]),
          snippet: snippetOf(stringOf(item["snippet"])),
          publishedAt: firstOrNull(item["date"], item["last_updated"]),
        }))
        .filter((result) => result.url.length > 0),
    };
  },
};
