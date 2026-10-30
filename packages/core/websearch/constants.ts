/**
 * Defaults and limits of the web-search library.
 *
 * One home for the numbers so the tools, the settings UI and the providers
 * cannot each invent their own: the tool descriptions quote these values to
 * the model, and a limit that only one of them knows would be reported
 * wrongly.
 */

/** Results returned by one search when the model does not say. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Most results one search can return. */
export const MAX_SEARCH_LIMIT = 10;

/** Characters of a page returned by one fetch when the model does not say. */
export const DEFAULT_FETCH_CHARS = 20_000;

/** Most characters one fetch can return. */
export const MAX_FETCH_CHARS = 100_000;

/** One search gives up after this long. */
export const SEARCH_TIMEOUT_MS = 20_000;

/** One page fetch gives up after this long. Longer than a search: a fetch
 * service has to load the page itself first. */
export const FETCH_TIMEOUT_MS = 60_000;

/** Bytes a direct fetch reads at most (checked against Content-Length and
 * while streaming). */
export const MAX_DIRECT_FETCH_BYTES = 5 * 1024 * 1024;

/** Characters a direct fetch keeps at most. */
export const MAX_DIRECT_FETCH_CHARS = 2_000_000;

/** Characters of one result's excerpt. */
export const MAX_SNIPPET_CHARS = 600;

/** Characters taken from an error response body. */
export const MAX_ERROR_DETAIL_CHARS = 400;
