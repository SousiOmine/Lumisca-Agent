/**
 * Exa: search and page contents.
 * Search: https://api.exa.ai/search
 * Contents: https://api.exa.ai/contents
 *
 * Authenticated with the `x-api-key` header (Exa also accepts a bearer
 * token; the official examples use the header).
 */

import {
  FETCH_TIMEOUT_MS,
  MAX_FETCH_CHARS,
  SEARCH_TIMEOUT_MS,
} from "../constants.ts";
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

const SEARCH_URL = "https://api.exa.ai/search";
const CONTENTS_URL = "https://api.exa.ai/contents";

/** Characters of page text asked for per search hit: enough for an excerpt,
 * not the whole page (the result list has to stay small). */
const SEARCH_TEXT_CHARS = 1_200;

export const exa: ProviderAdapter = {
  id: "exa",
  name: "Exa",
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
          numResults: numberLimit(request.limit),
          type: "auto",
          contents: { text: { maxCharacters: SEARCH_TEXT_CHARS } },
        }),
      },
      { timeoutMs: SEARCH_TIMEOUT_MS, signal: request.signal, provider: "Exa" },
    );

    return {
      results: arrayOf(json, "results")
        .map((item) => ({
          title: stringOf(item["title"], "(untitled)"),
          url: stringOf(item["url"]),
          snippet: snippetOf(stringOf(item["text"])),
          publishedAt: stringOrNull(item["publishedDate"]),
        }))
        .filter((result) => result.url.length > 0),
    };
  },

  async fetchPage(context, request) {
    const json = await requestJson(
      context.fetch,
      CONTENTS_URL,
      {
        method: "POST",
        headers: authHeaders(context.apiKey),
        body: JSON.stringify({
          urls: [request.url],
          text: { maxCharacters: MAX_FETCH_CHARS },
        }),
      },
      { timeoutMs: FETCH_TIMEOUT_MS, signal: request.signal, provider: "Exa" },
    );

    const first = arrayOf(json, "results")[0];
    if (first === undefined) {
      throw new WebSearchError(
        "unavailable",
        "Exa returned no content for the URL.",
      );
    }

    return {
      url: stringOf(first["url"], request.url),
      title: stringOrNull(first["title"]),
      text: stringOf(first["text"]),
    };
  },
};

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}
