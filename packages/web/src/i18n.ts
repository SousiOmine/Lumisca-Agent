/**
 * The UI language: one module store plus the hooks components use.
 *
 * The value itself lives on the server (a setting — see settings-keys.ts)
 * and reaches the page through `InitialData`; this module only mirrors it
 * for rendering. The store shape follows the other shared stores
 * (modelCatalog.ts, providers.ts): a module-level value with subscribers, so
 * every component that renders text re-renders when the language changes,
 * without prop drilling through the whole tree.
 *
 * Language changes are applied optimistically by useLanguage (a failed save
 * rolls back), so the store must be written only through it or setLocale.
 */
import { useMemo, useSyncExternalStore } from "preact/compat";
import { createStore } from "./store.ts";
import { ApiError } from "./api-client.ts";
import {
  createTranslator,
  DEFAULT_LOCALE,
  errorMessage,
  type Locale,
  type MessageKey,
  type MessageParams,
  translate,
  type Translator,
} from "@lumisca/core/shared";

const store = createStore<Locale>(DEFAULT_LOCALE);

/** The language the UI renders in right now. */
export function getLocale(): Locale {
  return store.get();
}

/** Seed the store from the server's bootstrap data, before the first
 * render (client.tsx). No notification: nothing is mounted yet. */
export function initLocale(locale: Locale): void {
  store.set(locale);
  applyDocumentLanguage();
}

/** Switch the language and re-render every consumer. */
export function setLocale(locale: Locale): void {
  if (locale === store.get()) return;
  store.set(locale);
  applyDocumentLanguage();
}

/** Subscribe to language changes (useLocale's subscription). */
export function subscribeLocale(listener: () => void): () => void {
  return store.subscribe(listener);
}

/** The current language, re-rendering the component when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale);
}

/** The message lookup for the current language. Components must call this
 * (a plain `t` call would not re-render on a language change). */
export function useT(): Translator {
  const locale = useLocale();
  return useMemo(() => createTranslator(locale), [locale]);
}

/** Message lookup outside the render tree (notification text, module-level
 * helpers). Components use {@link useT}. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(store.get(), key, params);
}

/**
 * A failure as a sentence the reader can act on: what kind of failure it was
 * in the app's language, plus the server's own explanation when it sent one.
 *
 * The raw message cannot be shown as-is — "Failed to fetch" is not Japanese
 * or English prose, and it does not say whether sending again could help —
 * so the kind picks the sentence and the server's text travels along as the
 * detail (a proxy's HTML page as that sentence would blame the wrong party).
 * Anything that is not an {@link ApiError} keeps its message: it did not come
 * from the transport, so no classification is known about it.
 *
 * Pure (the translator is passed in) so the table can be tested without a
 * browser or a store, and so a caller outside the render tree — a module
 * helper formatting a failure it will store — can pass the translator of the
 * language current at that moment.
 */
export function describeError(error: unknown, t: Translator): string {
  if (!(error instanceof ApiError)) return errorMessage(error);
  const line = t(
    error.kind === "network"
      ? "common.error.network"
      : error.kind === "http-4xx"
      ? "common.error.badRequest"
      : error.kind === "http-5xx"
      ? "common.error.server"
      : "common.error.parse",
  );
  return error.detail === null
    ? line
    : `${line}: ${t("common.error.detail", { detail: error.detail })}`;
}

/** Keep the document's language in sync: the stylesheet and assistive
 * technology use it (font fallback, hyphenation, screen-reader voice). */
function applyDocumentLanguage(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = store.get();
}
