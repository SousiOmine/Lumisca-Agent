/**
 * The provider table and the one SearchProvider built over it.
 *
 * Adding a provider means writing its adapter and listing it in ADAPTERS and
 * WEB_SEARCH_PROVIDER_IDS; the record type makes a missing entry a type
 * error, so the two can never drift. An adapter without a page API needs no
 * `fetchPage`: the direct fetch stands in.
 */

import { DEFAULT_FETCH_CHARS, MAX_FETCH_CHARS } from "../constants.ts";
import { fetchDirect } from "../direct-fetch.ts";
import type {
  CreateSearchProviderOptions,
  ProviderAdapter,
  ProviderInfo,
  SearchProvider,
  WebSearchProviderId,
} from "../types.ts";
import { brave } from "./brave.ts";
import { exa } from "./exa.ts";
import { numberLimit } from "./helpers.ts";
import { perplexity } from "./perplexity.ts";
import { tavily } from "./tavily.ts";
import { tinyfish } from "./tinyfish.ts";

/** The provider ids a setting may name. The order is the settings screen's
 * order of choices. */
export const WEB_SEARCH_PROVIDER_IDS: readonly WebSearchProviderId[] = [
  "exa",
  "tavily",
  "brave",
  "perplexity",
  "tinyfish",
];

/** Provider id → implementation. Must hold every id. */
const ADAPTERS: Record<WebSearchProviderId, ProviderAdapter> = {
  exa,
  tavily,
  brave,
  perplexity,
  tinyfish,
};

/** Every provider, for a settings screen that shows what it can choose. */
export const WEB_SEARCH_PROVIDERS: readonly ProviderInfo[] =
  WEB_SEARCH_PROVIDER_IDS.map((id) => providerInfo(id));

/** Whether a stored id names a provider this build has. */
export function isWebSearchProviderId(
  value: string,
): value is WebSearchProviderId {
  return (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

/** The display name and page-API support of one provider. */
export function providerInfo(id: WebSearchProviderId): ProviderInfo {
  const adapter = ADAPTERS[id];
  return { id, name: adapter.name, supportsFetch: adapter.supportsFetch };
}

/** Build the one provider interface over an adapter. */
export function createSearchProvider(
  options: CreateSearchProviderOptions,
): SearchProvider {
  const adapter = ADAPTERS[options.id];
  if (adapter === undefined) {
    throw new Error(`Unknown web search provider "${options.id}".`);
  }

  const context = {
    apiKey: options.apiKey,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };

  return {
    id: adapter.id,
    name: adapter.name,
    supportsFetch: adapter.supportsFetch,

    search(request) {
      return adapter.search(context, {
        ...request,
        limit: numberLimit(request.limit),
      });
    },

    async fetchPage(request) {
      const maxChars = clampChars(request.maxChars ?? DEFAULT_FETCH_CHARS);
      const page = adapter.fetchPage === undefined
        ? await fetchDirect(context.fetch, { ...request, maxChars })
        : await adapter.fetchPage(context, { ...request, maxChars });
      // Cut here rather than in each adapter: one place decides the unit
      // (characters) and the note that says text was dropped.
      return { ...page, text: cutText(page.text, maxChars) };
    },
  };
}

function clampChars(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FETCH_CHARS;
  return Math.min(Math.max(Math.trunc(value), 1_000), MAX_FETCH_CHARS);
}

/** Keep the head of a page and say how much was left out: the beginning of
 * a page is what a reader (and the model) needs first. */
function cutText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[${omitted} characters omitted]`;
}
