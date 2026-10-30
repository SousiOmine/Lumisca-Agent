/**
 * Tavily: search and page extraction.
 * Search: https://api.tavily.com/search
 * Extract: https://api.tavily.com/extract
 *
 * Authenticated with `Authorization: Bearer <key>`.
 */

import { FETCH_TIMEOUT_MS, SEARCH_TIMEOUT_MS } from "../constants.ts";
import { WebSearchError } from "../errors.ts";
import { requestJson } from "../http.ts";
import type { ProviderAdapter } from "../types.ts";
import {
  arrayOf,
  numberLimit,
  snippetOf,
  stringOf,
  stringOrNull,
} from "./helpers.ts";

const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";

/** Seconds Tavily may spend extracting one URL. */
const EXTRACT_TIMEOUT_SECONDS = 30;

export const tavily: ProviderAdapter = {
  id: "tavily",
  name: "Tavily",
  supportsFetch: true,

  async search(context, request) {
    const json = await requestJson(
      context.fetch,
      SEARCH_URL,
      {
        method: "POST",
        headers: authHeaders(context.apiKey),
        body: JSON.stringify({
          query: request.query,
          max_results: numberLimit(request.limit),
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
        }),
      },
      {
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: request.signal,
        provider: "Tavily",
      },
    );

    return {
      results: arrayOf(json, "results")
        .map((item) => ({
          title: stringOf(item["title"], "(untitled)"),
          url: stringOf(item["url"]),
          snippet: snippetOf(stringOf(item["content"])),
          publishedAt: stringOrNull(item["published_date"]),
        }))
        .filter((result) => result.url.length > 0),
    };
  },

  async fetchPage(context, request) {
    const json = await requestJson(
      context.fetch,
      EXTRACT_URL,
      {
        method: "POST",
        headers: authHeaders(context.apiKey),
        body: JSON.stringify({
          urls: [request.url],
          extract_depth: "basic",
          format: "markdown",
          timeout: EXTRACT_TIMEOUT_SECONDS,
        }),
      },
      {
        timeoutMs: FETCH_TIMEOUT_MS,
        signal: request.signal,
        provider: "Tavily",
      },
    );

    const first = arrayOf(json, "results")[0];
    if (first === undefined) {
      // A URL Tavily could not read is reported in failed_results, often
      // with HTTP 200.
      const failure = arrayOf(json, "failed_results")[0];
      throw new WebSearchError(
        "unavailable",
        stringOf(failure?.["error"], "Tavily could not extract the page."),
      );
    }

    return {
      url: stringOf(first["url"], request.url),
      title: stringOrNull(first["title"]),
      text: stringOf(first["raw_content"]),
    };
  },
};

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}
