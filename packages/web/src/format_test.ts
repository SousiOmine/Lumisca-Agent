import { assertEquals } from "@std/assert";
import { createTranslator } from "@lumisca/core/shared";
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  thinkingLevelLabel,
} from "./format.ts";

const ja = createTranslator("ja");
const en = createTranslator("en");

/** A fixed "now" so the assertions do not depend on the clock. */
const NOW = new Date(2026, 8, 15, 12, 0, 0).getTime();

Deno.test("formatRelativeTime: under a minute is the catalogue's 'just now'", () => {
  assertEquals(formatRelativeTime(NOW - 30_000, "ja", NOW), "たった今");
  assertEquals(formatRelativeTime(NOW - 30_000, "en", NOW), "just now");
});

Deno.test("formatRelativeTime: minutes, hours and days follow the language", () => {
  // The English wording is stable enough to assert exactly; the Japanese
  // one is checked for its unit so an ICU spacing change cannot break the
  // test.
  assertEquals(
    formatRelativeTime(NOW - 5 * 60_000, "en", NOW),
    "5 minutes ago",
  );
  assertEquals(
    formatRelativeTime(NOW - 3 * 3_600_000, "en", NOW),
    "3 hours ago",
  );
  assertEquals(
    formatRelativeTime(NOW - 2 * 86_400_000, "en", NOW),
    "2 days ago",
  );

  const minutes = formatRelativeTime(NOW - 5 * 60_000, "ja", NOW);
  assertEquals(minutes.includes("5"), true, minutes);
  assertEquals(minutes.includes("分前"), true, minutes);
  const days = formatRelativeTime(NOW - 2 * 86_400_000, "ja", NOW);
  assertEquals(days.includes("日前"), true, days);
});

Deno.test("formatRelativeTime: a week old falls back to a date", () => {
  const old = NOW - 10 * 86_400_000;
  assertEquals(
    formatRelativeTime(old, "en", NOW),
    new Date(old).toLocaleDateString("en-US", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }),
  );
});

Deno.test("formatDate/formatDateTime: numeric per language", () => {
  // What the app relies on is the order the parts come in — English leads
  // with the month, Japanese with the year — and that the value is numeric.
  // The separators and the clock format belong to Intl and change with an
  // ICU update; pinning them made this test fail on a routine upgrade
  // without anything in the app having broken.
  const en = formatDate(NOW, "en");
  const ja = formatDate(NOW, "ja");
  assertEquals(/\d/.test(en) && /\d/.test(ja), true, `${en} / ${ja}`);
  assertEquals(/(^|\D)9(\D|$)/.test(en), true, en);
  assertEquals(en.indexOf("9") < en.indexOf("2026"), true, `en: ${en}`);
  assertEquals(ja.indexOf("2026") < ja.indexOf("9"), true, `ja: ${ja}`);

  // Date + time keeps the language's date order and adds a clock.
  const dateTimeEn = formatDateTime(NOW, "en");
  assertEquals(dateTimeEn.includes("9"), true, dateTimeEn);
  assertEquals(dateTimeEn.includes("2026"), true, dateTimeEn);
  assertEquals(/\d:\d/.test(dateTimeEn), true, dateTimeEn);
  const dateTimeJa = formatDateTime(NOW, "ja");
  assertEquals(dateTimeJa.indexOf("2026") < dateTimeJa.indexOf("9"), true);
});

Deno.test("thinkingLevelLabel: the display names live in the catalogue", () => {
  assertEquals(thinkingLevelLabel("off", en), "Off");
  assertEquals(thinkingLevelLabel("off", ja), "オフ");
  assertEquals(thinkingLevelLabel("xhigh", en), "Extra high");
  assertEquals(thinkingLevelLabel("xhigh", ja), "最高");
});
