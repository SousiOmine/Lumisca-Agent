/**
 * Reading provider responses.
 *
 * Every provider answers with a list of results carrying a title, a URL, an
 * excerpt and a date, only the nesting and the field names differ. The
 * readers below are shared so a new provider writes its mapping and nothing
 * else, and a response whose shape changed degrades to empty fields instead
 * of throwing.
 */

import { isRecord } from "../../fs.ts";
import { htmlToText } from "../html.ts";
import { MAX_SEARCH_LIMIT, MAX_SNIPPET_CHARS } from "../constants.ts";
import { clip, oneLine } from "../http.ts";

/** The records inside `value[key]`, skipping anything malformed. */
export function arrayOf(
  value: unknown,
  key: string,
): Record<string, unknown>[] {
  const list = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(list)) return [];

  return list.filter(isRecord);
}

/** The value when it is a string, otherwise `fallback`. */
export function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A non-empty, trimmed string, or null. */
export function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The first non-null value of these candidates. */
export function firstOrNull(...values: unknown[]): string | null {
  for (const value of values) {
    const found = stringOrNull(value);
    if (found !== null) return found;
  }
  return null;
}

/** The requested count, clamped to what providers accept. */
export function numberLimit(value: number): number {
  const rounded = Number.isFinite(value) ? Math.trunc(value) : 1;
  return Math.min(Math.max(rounded, 1), MAX_SEARCH_LIMIT);
}

/** A one-line excerpt. Some providers (Brave) hand back HTML, so markup is
 * stripped first. */
export function snippetOf(value: string, maxChars = MAX_SNIPPET_CHARS): string {
  const text = oneLine(htmlToText(value));
  return clip(text, maxChars);
}

/** Several highlight strings joined into one excerpt. */
export function joinedSnippet(
  values: readonly unknown[],
  maxChars = MAX_SNIPPET_CHARS,
): string {
  const parts = values
    .map((value) => stringOrNull(value))
    .filter((value): value is string => value !== null);
  return snippetOf(parts.join(" … "), maxChars);
}
