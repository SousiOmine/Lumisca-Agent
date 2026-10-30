/**
 * Line and range helpers shared by both file backends and the VM shell.
 * Kept beside base64.ts because it is plain text algebra with no owner.
 */

import type { LineRange } from "./tools/file-backend.ts";

/** Sort ranges by start and merge overlaps/adjacency. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

/** Drop the `\r` of a CRLF line (the tools report text without it). */
export function stripTrailingCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** First line of a command's error output, for a one-sentence reason. */
export function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line === "" ? "(no output)" : line.trim();
}
