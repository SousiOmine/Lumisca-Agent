/**
 * Locale-aware formatting and labels for the UI (dates, relative times,
 * thinking levels).
 *
 * The strings around the values come from the message catalogue; the values
 * themselves are formatted with `Intl`, which knows the languages' date
 * shapes and plural rules, so a table of unit words in the catalogue would
 * be a worse copy of it.
 */
import {
  type Locale,
  localeTag,
  type MessageKey,
  type ThinkingLevel,
  translate,
  type Translator,
} from "@lumisca/core/shared";

/** Catalogue key of each reasoning-effort level's display name. The level
 * ids are the wire values (they go to the model API as they are); only the
 * names the UI shows are translated. */
const THINKING_LEVEL_KEYS: Record<ThinkingLevel, MessageKey> = {
  off: "common.thinking.off",
  minimal: "common.thinking.minimal",
  low: "common.thinking.low",
  medium: "common.thinking.medium",
  high: "common.thinking.high",
  xhigh: "common.thinking.xhigh",
  max: "common.thinking.max",
};

/** Display name of a thinking level ("Off" / "オフ"). */
export function thinkingLevelLabel(
  level: ThinkingLevel,
  t: Translator,
): string {
  return t(THINKING_LEVEL_KEYS[level]);
}

const relativeTimeFormats = new Map<Locale, Intl.RelativeTimeFormat>();

function relativeTimeFormat(locale: Locale): Intl.RelativeTimeFormat {
  let format = relativeTimeFormats.get(locale);
  if (format === undefined) {
    // numeric: "always" keeps "1日前" / "1 day ago" instead of the
    // languages' word forms ("昨日" / "yesterday"), matching what the
    // session list showed before the app had languages.
    format = new Intl.RelativeTimeFormat(localeTag(locale), {
      numeric: "always",
    });
    relativeTimeFormats.set(locale, format);
  }
  return format;
}

/** A past timestamp as "3分前" / "3 minutes ago"; older than a week it is
 * shown as a date instead (the recent-session list). `now` is injectable
 * for tests. */
export function formatRelativeTime(
  timestamp: number,
  locale: Locale,
  now: number = Date.now(),
): string {
  const diff = now - timestamp;
  if (diff < 60_000) return translate(locale, "common.justNow");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) {
    return relativeTimeFormat(locale).format(-minutes, "minute");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relativeTimeFormat(locale).format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return relativeTimeFormat(locale).format(-days, "day");
  return formatDate(timestamp, locale);
}

/** A timestamp as a date in the app language ("2026/9/15" / "9/15/2026"). */
export function formatDate(timestamp: number, locale: Locale): string {
  return new Date(timestamp).toLocaleDateString(localeTag(locale), {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

/** A timestamp as a time of day in the app language ("14:05" / "2:05 PM").
 * A conversation shows it under each message, so it is the clock alone —
 * the date is the separator's job (see {@link formatDaySeparator}). */
export function formatClockTime(timestamp: number, locale: Locale): string {
  return new Date(timestamp).toLocaleTimeString(localeTag(locale), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Midnight of the day a timestamp falls on, in local time. Two messages
 * belong to the same day exactly when these numbers are equal: comparing
 * the calendar fields (rather than a fixed 24-hour span) keeps a
 * conversation that spans a daylight-saving change from splitting mid-day. */
export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The label of a day's separator in a conversation: "今日" / "Yesterday"
 * for the two days the reader thinks in, a date for anything older. The
 * thresholds are the calendar's, so an evening message and the next
 * morning's are always told apart. */
export function formatDaySeparator(
  timestamp: number,
  locale: Locale,
  now: number = Date.now(),
): string {
  const day = startOfDay(timestamp);
  const today = startOfDay(now);
  if (day === today) return translate(locale, "common.daySeparator.today");
  // The previous calendar day, compared by date rather than by subtracting
  // 24 hours (which a daylight-saving change makes wrong).
  const previous = new Date(today);
  previous.setDate(previous.getDate() - 1);
  if (day === previous.getTime()) {
    return translate(locale, "common.daySeparator.yesterday");
  }
  return formatDate(timestamp, locale);
}
