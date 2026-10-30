/**
 * The configured provider, and a way to check a key before it is saved.
 *
 * The library (websearch/, minus this file) knows nothing about settings;
 * this is the one place that connects the two, the way an app connects a
 * library to its configuration store.
 */

import { errorMessage } from "../shared/misc.ts";
import type { Locale } from "../shared/i18n/mod.ts";
import type { WebSearchTestView } from "../shared/web-search.ts";
import { WebSearchError } from "./errors.ts";
import { failureText } from "./failure-text.ts";
import { createSearchProvider } from "./providers/registry.ts";
import type { WebSearchSettingsStore } from "./settings.ts";
import type { FetchLike, SearchProvider } from "./types.ts";

/** A search phrase for the connection check: short, and one every provider
 * answers with results. */
const TEST_QUERY = "web search connection test";

export interface WebSearchManager {
  /** The provider the agent searches with, or null when none is usable. */
  provider(): SearchProvider | null;
  /** Check a key before saving it. Writes nothing. */
  testKey(
    input: { id: string; apiKey: string },
    signal?: AbortSignal,
  ): Promise<WebSearchTestView>;
}

export function createWebSearchManager(options: {
  settings: WebSearchSettingsStore;
  /** The app language, for the reason a check failed. */
  locale: () => Locale;
  /** Tests replace the transport. */
  fetch?: FetchLike;
}): WebSearchManager {
  const build = (
    apiKey: string,
    id: Parameters<typeof createSearchProvider>[0]["id"],
  ) =>
    createSearchProvider({
      id,
      apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

  return {
    provider() {
      const settings = options.settings.read();
      const id = settings.defaultId;
      if (id === null) return null;
      const entry = settings.providers.get(id);
      if (entry === undefined) return null;
      return build(entry.apiKey, id);
    },

    async testKey({ id, apiKey }, signal) {
      // The route has already checked that `id` names a provider; the cast
      // below is what that check bought.
      const providerId = id as Parameters<typeof createSearchProvider>[0]["id"];
      const key = apiKey.trim();
      if (key.length === 0) {
        return {
          ok: false,
          detail: failureText(
            options.locale(),
            "auth",
            "the API key is empty",
          ),
          results: 0,
        };
      }

      try {
        const provider = build(key, providerId);
        const response = await provider.search({
          query: TEST_QUERY,
          limit: 1,
          ...(signal === undefined ? {} : { signal }),
        });
        return { ok: true, detail: null, results: response.results.length };
      } catch (error) {
        if (error instanceof WebSearchError) {
          return {
            ok: false,
            detail: failureText(options.locale(), error.code, error.message),
            results: 0,
          };
        }
        return { ok: false, detail: errorMessage(error), results: 0 };
      }
    },
  };
}
