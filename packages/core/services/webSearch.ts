import type {
  WebSearchSettingsView,
  WebSearchTestView,
} from "../shared/mod.ts";
import type { WebSearchService } from "../websearch/service.ts";

/**
 * The web-search providers the agent can search with: which are configured,
 * which one is the default, and the pre-save key check.
 *
 * The configuration itself lives in the settings file; WebSearchService turns
 * it into the provider a session uses.
 */
export class WebSearchConfigService {
  constructor(private readonly webSearch: WebSearchService) {}

  /** The web-search setting, as the settings screen shows it: which
   * providers are configured, which one search uses, and which can still be
   * added. Keys never leave this process; only whether one is stored. */
  getWebSearchSettings(): WebSearchSettingsView {
    return this.webSearch.view();
  }

  /** Add a search provider. The first one becomes the default, so a user who
   * adds one provider has working search without a second step. */
  addWebSearchProvider(
    input: { id: string; apiKey: string },
  ): WebSearchSettingsView {
    return this.webSearch.add(input);
  }

  /** Replace one provider's key; an empty key keeps the stored one. */
  updateWebSearchProvider(
    id: string,
    input: { apiKey: string },
  ): WebSearchSettingsView {
    return this.webSearch.update(id, input);
  }

  /** Remove a provider (the default moves to the next one when it was the
   * default). */
  removeWebSearchProvider(id: string): WebSearchSettingsView {
    return this.webSearch.remove(id);
  }

  /** Choose the provider search uses; null turns search off. */
  setDefaultWebSearchProvider(id: string | null): WebSearchSettingsView {
    return this.webSearch.setDefault(id);
  }

  /** Search once with a key the user typed, saving nothing (the screen
   * checks before it stores). A failure is the answer, not an exception. */
  testWebSearchProvider(input: {
    id: string;
    apiKey: string | null;
  }): Promise<WebSearchTestView> {
    return this.webSearch.test(input);
  }
}
