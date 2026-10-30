/**
 * TinyFish: search and page fetch.
 * Search: https://api.search.tinyfish.ai
 * Fetch: https://api.fetch.tinyfish.ai
 *
 * Authenticated with the `X-API-Key` header. The fetch returns the page as
 * markdown, which is readable as it is.
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

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";

export const tinyfish: ProviderAdapter = {
  id: "tinyfish",
  name: "TinyFish",
  supportsFetch: true,

  async search(context, request) {
    const params = new URLSearchParams({ query: request.query });

    const json = await requestJson(
      context.fetch,
      `${SEARCH_URL}?${params.toString()}`,
      {
        method: "GET",
        headers: { Accept: "application/json", "X-API-Key": context.apiKey },
      },
      {
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: request.signal,
        provider: "TinyFish",
      },
    );

    return {
      results: arrayOf(json, "results")
        .slice(0, numberLimit(request.limit))
        .map((item) => ({
          title: stringOf(item["title"], "(untitled)"),
          url: stringOf(item["url"]),
          snippet: snippetOf(stringOf(item["snippet"])),
          publishedAt: stringOrNull(item["date"]),
        }))
        .filter((result) => result.url.length > 0),
    };
  },

  async fetchPage(context, request) {
    const json = await requestJson(
      context.fetch,
      FETCH_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-Key": context.apiKey,
        },
        body: JSON.stringify({ urls: [request.url], format: "markdown" }),
      },
      {
        timeoutMs: FETCH_TIMEOUT_MS,
        signal: request.signal,
        provider: "TinyFish",
      },
    );

    // A URL TinyFish could not read is reported in errors, often with
    // HTTP 200.
    const failure = arrayOf(json, "errors")[0];
    if (failure !== undefined) {
      throw new WebSearchError(
        "unavailable",
        stringOf(failure["error"], "TinyFish could not fetch the URL."),
      );
    }

    const first = arrayOf(json, "results")[0];
    if (first === undefined) {
      throw new WebSearchError(
        "unavailable",
        "TinyFish returned no content for the URL.",
      );
    }

    return {
      url: stringOf(first["final_url"], stringOf(first["url"], request.url)),
      title: stringOrNull(first["title"]),
      text: stringOf(first["text"]),
    };
  },
};
