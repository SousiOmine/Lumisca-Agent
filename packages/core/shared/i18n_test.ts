import { assert, assertEquals } from "@std/assert";
import { chat } from "./i18n/chat.ts";
import { chrome } from "./i18n/chrome.ts";
import { common } from "./i18n/common.ts";
import { panels } from "./i18n/panels.ts";
import { settings } from "./i18n/settings.ts";
import {
  createTranslator,
  DEFAULT_LOCALE,
  isLocale,
  localeForTag,
  LOCALES,
  localeTag,
  messages,
  parseAcceptLanguage,
  parseLocale,
  resolveLocale,
  translate,
} from "./i18n/mod.ts";

/** Each area file's own table, for the duplicate-key check (the catalogue
 * spread merges them, which is exactly what hides a collision). */
const AREA_TABLES = { common, chrome, settings, chat, panels };

// --- locale resolution ------------------------------------------------------

Deno.test("isLocale/parseLocale accept the supported languages only", () => {
  for (const locale of LOCALES) {
    assertEquals(isLocale(locale), true);
    assertEquals(parseLocale(locale), locale);
  }
  assertEquals(isLocale("fr"), false);
  assertEquals(isLocale(undefined), false);
  assertEquals(isLocale(42), false);
  // An unset or unknown stored value is "not chosen", never a fallback: the
  // caller decides what comes next (resolveLocale).
  assertEquals(parseLocale(undefined), undefined);
  assertEquals(parseLocale(null), undefined);
  assertEquals(parseLocale(""), undefined);
  assertEquals(parseLocale("JA"), undefined);
});

Deno.test("localeForTag: Japanese → ja, every other language → en", () => {
  assertEquals(localeForTag("ja"), "ja");
  assertEquals(localeForTag("ja-JP"), "ja");
  assertEquals(localeForTag("JA-jp"), "ja");
  assertEquals(localeForTag("en-US"), "en");
  assertEquals(localeForTag("en"), "en");
  // English is the app's fallback for languages it does not speak.
  assertEquals(localeForTag("de-DE"), "en");
  assertEquals(localeForTag("zh-Hans-CN"), "en");
  // A tag that names no language keeps the caller's fallback chain going.
  assertEquals(localeForTag(""), undefined);
  assertEquals(localeForTag("   "), undefined);
  assertEquals(localeForTag(undefined), undefined);
  assertEquals(localeForTag(null), undefined);
});

Deno.test("parseAcceptLanguage orders by quality and drops the wildcard", () => {
  assertEquals(parseAcceptLanguage("ja,en-US;q=0.9,en;q=0.8"), [
    "ja",
    "en-US",
    "en",
  ]);
  // Quality beats position.
  assertEquals(parseAcceptLanguage("ja;q=0.5,en;q=0.9"), ["en", "ja"]);
  // The wildcard names no language.
  assertEquals(parseAcceptLanguage("*"), []);
  assertEquals(parseAcceptLanguage("de,*;q=0.5"), ["de"]);
  // Malformed input must never throw on the request path. A quality the
  // parser cannot read keeps the default (most preferred) instead of
  // dropping the tag.
  assertEquals(parseAcceptLanguage(""), []);
  assertEquals(parseAcceptLanguage(undefined), []);
  assertEquals(parseAcceptLanguage(";;;"), []);
  assertEquals(parseAcceptLanguage("ja;q=abc,en"), ["ja", "en"]);
  // Equal qualities keep the header's order.
  assertEquals(parseAcceptLanguage("fr,ja"), ["fr", "ja"]);
});

Deno.test("resolveLocale: stored setting wins, then the tags, then the default", () => {
  // The stored setting is the user's explicit choice.
  assertEquals(resolveLocale("en", ["ja-JP"]), "en");
  assertEquals(resolveLocale("ja", ["en-US"]), "ja");
  // An unknown stored value falls through to the environment.
  assertEquals(resolveLocale("fr", ["ja-JP"]), "ja");
  assertEquals(resolveLocale(undefined, ["ja-JP", "en-US"]), "ja");
  // Only the most preferred tag decides: a browser that prefers German
  // gets English even when Japanese is also acceptable.
  assertEquals(resolveLocale(undefined, ["de", "ja"]), "en");
  assertEquals(resolveLocale(null, []), DEFAULT_LOCALE);
  assertEquals(resolveLocale(undefined, []), DEFAULT_LOCALE);
});

Deno.test("localeTag pins an Intl tag per language", () => {
  assertEquals(localeTag("ja"), "ja-JP");
  assertEquals(localeTag("en"), "en-US");
});

// --- message lookup ---------------------------------------------------------

Deno.test("translate returns the message of the language", () => {
  assertEquals(translate("ja", "common.close"), "閉じる");
  assertEquals(translate("en", "common.close"), "Close");
  // A bound translator behaves the same.
  const en = createTranslator("en");
  assertEquals(en("common.close"), "Close");
});

Deno.test("translate interpolates {name} placeholders", () => {
  assertEquals(
    translate("ja", "common.sessionName", { date: "12:00" }),
    "セッション 12:00",
  );
  assertEquals(
    translate("en", "common.sessionName", { date: "12:00" }),
    "Session 12:00",
  );
  // A missing value leaves the placeholder visible instead of printing
  // "undefined": a broken sentence the user can report beats a silent lie.
  assertEquals(
    translate("en", "common.sessionName", {}),
    "Session {date}",
  );
  // Repeated placeholders are all replaced.
  assertEquals(
    translate("en", "notify.question", { name: "S", detail: ": x" }),
    '"S" has a question: x',
  );
});

// --- catalogue invariants ---------------------------------------------------

/** The catalogue's area files, by the name each exports (see messages.ts,
 * which spreads them into one table). */
const AREAS = ["common", "chrome", "settings", "chat", "panels"] as const;

Deno.test("catalogue: no key is defined in two area files", () => {
  // `messages` is a spread of the area tables, so a key present in two of
  // them resolves to whichever is spread last — silently, and with no type
  // error (both have the same shape). A key belongs to exactly one surface.
  const owner = new Map<string, string>();
  const duplicates: string[] = [];
  for (const area of AREAS) {
    const table = AREA_TABLES[area] as Record<string, unknown>;
    for (const key of Object.keys(table)) {
      const previous = owner.get(key);
      if (previous !== undefined) {
        duplicates.push(`${key} (${previous} and ${area})`);
      } else {
        owner.set(key, area);
      }
    }
  }
  assertEquals(
    duplicates,
    [],
    `keys defined in two area files: ${duplicates.join(", ")}`,
  );
});

Deno.test("catalogue: a generic action is not redefined per surface", () => {
  // The generic verbs live in common.ts and every surface uses them: a save
  // button, a delete icon's tooltip and a dialog's close are the same act
  // wherever they appear. A surface that spells one of them again (the same
  // two languages for a second key) has started its own copy: the next
  // rewording fixes one of them, and the app ends up saying "Delete" in one
  // place and "Remove" in another for the same button.
  //
  // Only the generic actions are checked. A short word may legitimately
  // recur for DIFFERENT meanings (完了 is a todo's status and also a
  // hand-over's button), and forcing those into one key would couple two
  // unrelated surfaces.
  const generic = new Set([
    "common.close",
    "common.cancel",
    "common.save",
    "common.delete",
    "common.edit",
    "common.reload",
    "common.loading",
  ]);
  const wording = new Map<string, string>();
  for (const key of generic) {
    const entry = messages[key as keyof typeof messages];
    wording.set(`${entry.ja}\u0000${entry.en}`, key);
  }
  const redefinitions: string[] = [];
  for (const area of AREAS) {
    const table = AREA_TABLES[area] as Record<
      string,
      { ja: string; en: string }
    >;
    for (const [key, entry] of Object.entries(table)) {
      if (generic.has(key)) continue;
      const owner = wording.get(`${entry.ja}\u0000${entry.en}`);
      if (owner !== undefined) {
        redefinitions.push(`${area}:${key} (use ${owner})`);
      }
    }
  }
  assertEquals(
    redefinitions,
    [],
    `a generic action spelled again: ${redefinitions.join(", ")}`,
  );
});

/** Placeholder names of a message, in order of appearance. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
}

Deno.test("catalogue: every entry has both languages, non-empty", () => {
  const keys = Object.keys(messages);
  assert(keys.length > 0, "the catalogue is not empty");
  for (const key of keys) {
    const entry = messages[key as keyof typeof messages];
    assert(entry.ja.length > 0, `empty ja message: ${key}`);
    assert(entry.en.length > 0, `empty en message: ${key}`);
  }
});

Deno.test("catalogue: placeholders match between the languages", () => {
  // A translation that drops or renames a placeholder renders a sentence
  // with a missing value (or an unreplaced "{x}"), which no type can catch.
  for (const key of Object.keys(messages)) {
    const entry = messages[key as keyof typeof messages];
    assertEquals(
      placeholders(entry.en).sort(),
      placeholders(entry.ja).sort(),
      `placeholder mismatch in ${key}`,
    );
  }
});

Deno.test("catalogue: user-facing text is not left in one language only", () => {
  // A copy-pasted entry (the English left equal to the Japanese) is only
  // legitimate for strings that are the same in both languages: borrowed
  // technical terms and proper nouns that the Japanese UI also spells in
  // Latin letters.
  const allowed = new Set([
    "settings.language.option.en", // "English" in both
    "settings.userProvider.baseUrlLabel", // "Base URL" in both
    "settings.userProvider.apiLabel", // "API" in both
    "settings.mcp.typeHttp", // protocol name: "HTTP (streamable)" in both
    "settings.mcp.urlLabel", // "URL" in both
    // Product names: the mode names are the same word in every language.
    "chat.modeSelect.code.title",
    "chat.modeSelect.stella.title",
  ]);
  for (const key of Object.keys(messages)) {
    if (allowed.has(key)) continue;
    const entry = messages[key as keyof typeof messages];
    assert(
      entry.ja !== entry.en,
      `untranslated message (ja === en): ${key}`,
    );
  }
});
