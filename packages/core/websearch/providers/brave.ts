/**
 * Brave Search: search only (pages are fetched directly).
 * Search: https://api.search.brave.com/res/v1/web/search
 *
 * Authenticated with the `X-Subscription-Token` header.
 */

import { isRecord } from "../../fs.ts";
import { SEARCH_TIMEOUT_MS } from "../constants.ts";
import { requestJson } from "../http.ts";
import type { ProviderAdapter } from "../types.ts";
import { firstOrNull, numberLimit, snippetOf, stringOf } from "./helpers.ts";

const SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export const brave: ProviderAdapter = {
  id: "brave",
  name: "Brave Search",
  supportsFetch: false,

  async search(context, request) {
    const params = new URLSearchParams({
      q: request.query,
      count: String(numberLimit(request.limit)),
      text_decorations: "false",
      safesearch: "moderate",
    });

    const json = await requestJson(
      context.fetch,
      `${SEARCH_URL}?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": context.apiKey,
        },
      },
      {
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: request.signal,
        provider: "Brave Search",
      },
    );

    // Hits live in web.results; web is absent when nothing matched.
    const web = isRecord(json) ? json["web"] : undefined;
    const list = isRecord(web) ? web["results"] : undefined;
    if (!Array.isArray(list)) return { results: [] };

    return {
      results: list
        .filter(isRecord)
        .map((item) => ({
          title: stringOf(item["title"], "(untitled)"),
          url: stringOf(item["url"]),
          snippet: snippetOf(stringOf(item["description"])),
          publishedAt: firstOrNull(item["page_age"], item["age"]),
        }))
        .filter((result) => result.url.length > 0),
    };
  },
};
