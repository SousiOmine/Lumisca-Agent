/**
 * The shape of a search provider.
 *
 * One vocabulary for every provider: what a search takes, what it returns,
 * and what a page fetch takes. The implementations (providers/) fill it in;
 * the tools only ever see this.
 */

/** Replaces `fetch` so tests answer without touching the network. */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** The provider ids, owned by the wire shape (shared/web-search.ts) so the
 * settings screen and the provider table read one list. Adding a provider
 * means adding it to providers/registry.ts as well. */
export type { WebSearchProviderId } from "../shared/web-search.ts";
import type { WebSearchProviderId } from "../shared/web-search.ts";

/** One search request. */
export interface SearchRequest {
  query: string;
  /** How many results to return; 1 or more (each provider clamps it too). */
  limit: number;
  /** The caller's abort. */
  signal?: AbortSignal;
}

/** One search result. */
export interface SearchResult {
  title: string;
  url: string;
  /** A single line for the listing; never contains newlines. */
  snippet: string;
  /** Publication date as the provider reports it, or null. */
  publishedAt: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
}

/** One page fetch. */
export interface FetchRequest {
  url: string;
  /** Characters to return at most. Omitted → the default. */
  maxChars?: number;
  signal?: AbortSignal;
}

/** The readable text of one page. */
export interface FetchResponse {
  /** The URL after redirects. */
  url: string;
  title: string | null;
  text: string;
}

/** The provider the rest of the app uses: one interface over all of them. */
export interface SearchProvider {
  readonly id: WebSearchProviderId;
  readonly name: string;
  /** Whether the provider has its own page API (otherwise pages are fetched
   * and converted here). */
  readonly supportsFetch: boolean;
  search(request: SearchRequest): Promise<SearchResponse>;
  fetchPage(request: FetchRequest): Promise<FetchResponse>;
}

/** What a provider implementation gets: credentials and transport. */
export interface ProviderContext {
  apiKey: string;
  fetch: FetchLike;
}

/** One provider. Implementations without a page API omit `fetchPage`; the
 * direct fetch stands in for them. */
export interface ProviderAdapter {
  readonly id: WebSearchProviderId;
  readonly name: string;
  readonly supportsFetch: boolean;
  search(context: ProviderContext, request: SearchRequest): Promise<
    SearchResponse
  >;
  fetchPage?(
    context: ProviderContext,
    request: FetchRequest,
  ): Promise<FetchResponse>;
}

/** What the settings screen shows of a provider. */
export interface ProviderInfo {
  id: WebSearchProviderId;
  name: string;
  supportsFetch: boolean;
}

/** How a provider is built. */
export interface CreateSearchProviderOptions {
  id: WebSearchProviderId;
  apiKey: string;
  /** Tests replace the transport. */
  fetch?: FetchLike;
}
