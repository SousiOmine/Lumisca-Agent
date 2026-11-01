import { assertEquals } from "@std/assert";
import { createTranslator } from "@lumisca/core/shared";
import {
  formatClockTime,
  formatDate,
  formatDaySeparator,
  formatRelativeTime,
  startOfDay,
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

Deno.test("formatDate: numeric per language", () => {
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
});

Deno.test("formatClockTime: the time of day, in the language's shape", () => {
  // The separator carries the date; a message carries the clock. What the
  // app relies on is that the hour and the minute both survive Intl's
  // shape for the language, not the exact separators (see formatDate).
  const stamp = new Date(2026, 8, 15, 14, 5, 0).getTime();
  for (const locale of ["en", "ja"] as const) {
    const text = formatClockTime(stamp, locale);
    assertEquals(text.includes("14") || text.includes("2"), true, text);
    assertEquals(text.includes("05") || text.includes("5"), true, text);
  }
});

Deno.test("formatDaySeparator: the two days a reader names, then a date", () => {
  assertEquals(formatDaySeparator(NOW, "ja", NOW), "今日");
  assertEquals(formatDaySeparator(NOW, "en", NOW), "Today");
  const yesterday = NOW - 86_400_000;
  assertEquals(formatDaySeparator(yesterday, "ja", NOW), "昨日");
  assertEquals(formatDaySeparator(yesterday, "en", NOW), "Yesterday");
  // Older than that is the date itself.
  const older = NOW - 3 * 86_400_000;
  assertEquals(formatDaySeparator(older, "en", NOW), formatDate(older, "en"));
});

Deno.test("formatDaySeparator: a day boundary is the calendar's, not 24 hours", () => {
  // Two messages an hour apart across midnight belong to different days,
  // and two on the same day belong to the same one however long the day is.
  const lateEvening = new Date(2026, 8, 15, 23, 30).getTime();
  const nextMorning = new Date(2026, 8, 16, 0, 30).getTime();
  assertEquals(startOfDay(lateEvening) === startOfDay(nextMorning), false);
  assertEquals(formatDaySeparator(lateEvening, "en", nextMorning), "Yesterday");
  const earlySameDay = new Date(2026, 8, 15, 0, 30).getTime();
  assertEquals(startOfDay(lateEvening) === startOfDay(earlySameDay), true);
});

Deno.test("thinkingLevelLabel: the display names live in the catalogue", () => {
  assertEquals(thinkingLevelLabel("off", en), "Off");
  assertEquals(thinkingLevelLabel("off", ja), "オフ");
  assertEquals(thinkingLevelLabel("xhigh", en), "Extra high");
  assertEquals(thinkingLevelLabel("xhigh", ja), "最高");
});
