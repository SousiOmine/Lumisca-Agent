/**
 * The wire shape of the web-search setting: what the server answers and what
 * the settings screen renders.
 *
 * Frontend-safe (no Deno, no `node:`): the settings screen renders these
 * shapes, and it must not pull the search library (which reaches the
 * network) into the bundle.
 */

/** The search providers this build supports. The list lives here, in the
 * wire shape, so the settings screen and the provider table cannot disagree
 * about which ids exist; websearch/types.ts takes the type from here. */
export type WebSearchProviderId =
  | "exa"
  | "tavily"
  | "brave"
  | "perplexity"
  | "tinyfish";

/** One configured search provider. */
export interface WebSearchProviderView {
  id: WebSearchProviderId;
  name: string;
  /** Whether the provider has its own page API (otherwise pages are read
   * directly). */
  supportsFetch: boolean;
  /** Whether a key is stored. The key itself never leaves the server. */
  hasApiKey: boolean;
  isDefault: boolean;
}

/** A provider that is not configured yet, offered when adding one. */
export interface WebSearchAvailableProviderView {
  id: WebSearchProviderId;
  name: string;
  supportsFetch: boolean;
}

/** The whole web-search setting, as every mutation returns it. */
export interface WebSearchSettingsView {
  /** The provider the agent uses, or null when none is configured. */
  defaultId: WebSearchProviderId | null;
  providers: WebSearchProviderView[];
  /** Providers that can still be added. */
  available: WebSearchAvailableProviderView[];
}

/** Input of adding a provider: which one, and its key. */
export interface WebSearchProviderForm {
  id: string;
  apiKey: string;
}

/** Input of changing a provider's key. An empty key keeps the stored one,
 * so the screen can edit without holding the secret. */
export interface WebSearchProviderUpdate {
  apiKey: string;
}

/** The result of checking a key before saving it. A failure is reported in
 * the body (HTTP stays 200), the same way an MCP server test reports one. */
export interface WebSearchTestView {
  ok: boolean;
  detail: string | null;
  /** How many results the check search returned, as a sign that it worked. */
  results: number;
}
