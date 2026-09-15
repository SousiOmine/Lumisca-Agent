/**
 * The machine's own language preferences, used as the LAST fallback when
 * neither the stored setting nor the request names a language (see
 * shared/i18n resolveLocale).
 *
 * Kept out of `shared/` on purpose: it reads the runtime's environment
 * (POSIX variables, the ICU default locale), which the browser bundle must
 * never reach.
 */

/** POSIX locale variables, most specific first (the order glibc uses). */
const POSIX_VARIABLES = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

/** GNU's LANGUAGE variable: a colon-separated preference list. */
const LANGUAGE_VARIABLE = "LANGUAGE";

/**
 * The machine's language preferences as BCP-47 tags, most preferred first:
 * `LANGUAGE`, then the POSIX locale variables, then the runtime's resolved
 * locale. Empty when nothing names a language (a headless server with "C"
 * locale), so the caller keeps its own fallback.
 *
 * Best-effort by design: a missing permission (`--allow-env`) or an
 * environment without `Intl` yields fewer tags, never an error — the app
 * language must never be the reason a request fails.
 */
export function systemLanguageTags(): string[] {
  const tags: string[] = [];
  const language = readEnv(LANGUAGE_VARIABLE);
  if (language !== undefined) {
    for (const tag of language.split(":")) pushTag(tags, tag);
  }
  for (const name of POSIX_VARIABLES) {
    const value = readEnv(name);
    if (value === undefined) continue;
    // "ja_JP.UTF-8" → the locale part only; the codeset names no language.
    pushTag(tags, value.split(".")[0] ?? "");
  }
  pushTag(tags, resolvedLocaleTag() ?? "");
  return tags;
}

/** The runtime's default locale ("ja-JP" on a Japanese machine). */
function resolvedLocaleTag(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

function readEnv(name: string): string | undefined {
  try {
    // Without --allow-env this throws; the fallback chain continues.
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Record one tag: POSIX strings ("ja_JP") are normalized to tags
 * ("ja-JP"), and the locale-less values ("C", "POSIX") are dropped — they
 * express "no preference", not a language. */
function pushTag(tags: string[], raw: string): void {
  const tag = raw.trim().replace(/_/g, "-");
  if (tag === "" || tag === "C" || tag === "POSIX") return;
  tags.push(tag);
}
