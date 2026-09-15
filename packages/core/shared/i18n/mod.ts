/**
 * The app language: the locale type, the rules that pick a locale from the
 * environment, and message lookup.
 *
 * The selected language is ONE value for the whole app (a server setting,
 * see settings-keys.ts): the UI renders in it, and it is what a new
 * session's system prompt is generated with — the prompt is snapshotted at
 * creation, so a session speaks the language it started in even after the
 * setting changes (see agent/factory.ts and tools/language.ts).
 *
 * This module is frontend-safe (pure): the web package bundles it through
 * `@lumisca/core/shared`, and the runtime-specific parts of locale
 * detection — the browser's Accept-Language header, the machine's locale —
 * are supplied by the callers (server/routes, core/locale.ts).
 */
import { type MessageKey, messages } from "./messages.ts";

/** A supported app language. */
export type Locale = "ja" | "en";

/** Every supported language, in menu order. */
export const LOCALES: readonly Locale[] = ["ja", "en"];

/** The language used when nothing else names one: the app's original
 * language. Every other fallback (stored setting, browser, machine) is
 * tried first. */
export const DEFAULT_LOCALE: Locale = "ja";

/** Whether a value is a supported language (storage is plain strings). */
export function isLocale(value: unknown): value is Locale {
  return value === "ja" || value === "en";
}

/** The language a stored setting value names; undefined when unset or
 * unknown (the caller then keeps looking — see resolveLocale). */
export function parseLocale(
  raw: string | undefined | null,
): Locale | undefined {
  return isLocale(raw) ? raw : undefined;
}

/** The primary subtag of a BCP-47 tag, lowercased: "ja-JP" → "ja". */
function primarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split("-")[0] ?? "";
}

/**
 * The app language for one language tag: "ja" for Japanese, "en" for every
 * other language (English is the app's fallback, the industry default).
 * Undefined when the tag names no language at all, so the caller can keep
 * falling back instead of treating a missing header as a choice.
 */
export function localeForTag(
  tag: string | undefined | null,
): Locale | undefined {
  if (tag === undefined || tag === null) return undefined;
  const primary = primarySubtag(tag);
  if (primary === "") return undefined;
  return primary === "ja" ? "ja" : "en";
}

/**
 * The language tags of an `Accept-Language` header, most preferred first.
 * Quality values order the list ("ja;q=0.5,en;q=0.9" prefers English), the
 * wildcard is dropped (it names no language), and malformed entries are
 * ignored — a header must never be able to throw on the request path.
 */
export function parseAcceptLanguage(
  header: string | undefined | null,
): string[] {
  if (header === undefined || header === null) return [];
  const entries: { tag: string; quality: number; order: number }[] = [];
  header.split(",").forEach((part, index) => {
    const [rawTag, ...params] = part.split(";");
    const tag = (rawTag ?? "").trim();
    if (tag === "" || tag === "*") return;
    let quality = 1;
    for (const param of params) {
      const [name, value] = param.split("=");
      if ((name ?? "").trim().toLowerCase() !== "q") continue;
      const parsed = Number.parseFloat((value ?? "").trim());
      if (Number.isFinite(parsed)) quality = parsed;
    }
    entries.push({ tag, quality, order: index });
  });
  return entries
    .sort((a, b) => b.quality - a.quality || a.order - b.order)
    .map((entry) => entry.tag);
}

/**
 * The effective language: the stored setting when it names one, else the
 * most preferred tag of the environment (`tags` = the browser's
 * Accept-Language first, the machine's own locale after), else
 * {@link DEFAULT_LOCALE}.
 *
 * One rule for every caller (the server's first page load, the core's
 * prompt generation) so the UI and the session prompt can never disagree
 * about what "the app language" is.
 */
export function resolveLocale(
  stored: string | undefined | null,
  tags: readonly string[],
): Locale {
  return parseLocale(stored) ?? localeForTag(tags[0]) ?? DEFAULT_LOCALE;
}

/** Values substituted into `{name}` placeholders of a message. `null` and
 * `undefined` render as the empty string: interpolated values often come
 * from optional fields (the version of a pending update, an error that may
 * not have arrived), and a sentence with a gap beats "null" in the UI. */
export type MessageParams = Record<
  string,
  string | number | null | undefined
>;

/** The BCP-47 tag used for `Intl` formatting (dates, numbers, relative
 * times) in a locale. Pinned per language instead of left to the runtime:
 * the app language is the user's choice, and the runtime's default locale
 * (the browser's, the machine's) may differ from it. */
export function localeTag(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : "en-US";
}

/** A bound message lookup: `t("common.close")`. */
export type Translator = (key: MessageKey, params?: MessageParams) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Replace `{name}` placeholders. A name the caller did not pass at all is
 * left as written (a visible mistake beats a half-built sentence); a name
 * passed as null / undefined renders as a gap. */
function interpolate(text: string, params: MessageParams): string {
  return text.replace(PLACEHOLDER, (match, name: string) => {
    if (!(name in params)) return match;
    const value = params[name];
    return value === null || value === undefined ? "" : String(value);
  });
}

/** One message in one language. An unknown key returns the key itself: the
 * type system prevents that call, and a visible key in the UI is a better
 * failure mode than an empty element. */
export function translate(
  locale: Locale,
  key: MessageKey,
  params?: MessageParams,
): string {
  const entry = messages[key] as { ja: string; en: string } | undefined;
  const text = entry?.[locale] ?? key;
  return params === undefined ? text : interpolate(text, params);
}

/** Bind a lookup to one language. The web layer memoizes one per locale and
 * hands it to components (see web/src/i18n.ts). */
export function createTranslator(locale: Locale): Translator {
  return (key, params) => translate(locale, key, params);
}

export { type MessageKey, messages };
export type { LocalizedText } from "./types.ts";
