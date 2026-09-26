import { assert, assertEquals } from "@std/assert";
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
