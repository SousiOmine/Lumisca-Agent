/**
 * What the web-search library offers.
 *
 * Everything outside this directory imports from here, so the provider
 * implementations stay an implementation detail and the transport, the
 * settings shape and the failure kinds are reachable from one place.
 */

export {
  DEFAULT_FETCH_CHARS,
  DEFAULT_SEARCH_LIMIT,
  MAX_FETCH_CHARS,
  MAX_SEARCH_LIMIT,
} from "./constants.ts";
export { WebSearchError, type WebSearchErrorCode } from "./errors.ts";
export { failureText, WEB_SEARCH_FAILURE_TEXT } from "./failure-text.ts";
export { decodeEntities, htmlToText, pageTitle } from "./html.ts";
export { createWebSearchManager, type WebSearchManager } from "./manager.ts";
export {
  createSearchProvider,
  isWebSearchProviderId,
  providerInfo,
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDERS,
} from "./providers/registry.ts";
export {
  addWebSearchProvider,
  availableProviderIds,
  configuredProviderIds,
  createWebSearchSettingsStore,
  emptyWebSearchSettings,
  normalizeApiKey,
  parseWebSearchSettings,
  removeWebSearchProvider,
  serializeWebSearchSettings,
  setDefaultWebSearchProvider,
  type StoredWebSearchProvider,
  type StoredWebSearchSettings,
  updateWebSearchProvider,
  webSearchProviderName,
  type WebSearchSettingsStore,
} from "./settings.ts";
export { WebSearchService, type WebSearchServiceOptions } from "./service.ts";
export type {
  CreateSearchProviderOptions,
  FetchLike,
  FetchRequest,
  FetchResponse,
  ProviderAdapter,
  ProviderContext,
  ProviderInfo,
  SearchProvider,
  SearchRequest,
  SearchResponse,
  SearchResult,
  WebSearchProviderId,
} from "./types.ts";
