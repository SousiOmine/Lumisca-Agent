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
  assertEquals(formatDate(NOW, "en"), "9/15/2026");
  assertEquals(formatDate(NOW, "ja"), "2026/9/15");
  // Date + time keeps the language's order (the day part is asserted
  // loosely: the exact separator and clock format are the runtime's).
  const dateTime = formatDateTime(NOW, "en");
  assertEquals(dateTime.includes("9/15/2026"), true, dateTime);
  assertEquals(formatDateTime(NOW, "ja").includes("2026/9/15"), true);
});

Deno.test("thinkingLevelLabel: the display names live in the catalogue", () => {
  assertEquals(thinkingLevelLabel("off", en), "Off");
  assertEquals(thinkingLevelLabel("off", ja), "オフ");
  assertEquals(thinkingLevelLabel("xhigh", en), "Extra high");
  assertEquals(thinkingLevelLabel("xhigh", ja), "最高");
});
