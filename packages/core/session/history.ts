import { CoreError } from "../errors.ts";
import type { MessageWindow } from "../session/messages.ts";
import type { StellaEntry } from "../domain/stella-conversation.ts";
import { TOOL_HISTORY_SEARCH } from "../shared/mod.ts";
import { formatLocalDateTime } from "../shared/misc.ts";
import {
  integer,
  object,
  optional,
  type SchemaInteger,
  type SchemaObject,
  type SchemaOptional,
  type SchemaString,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import { truncatedHeadNote, truncateHead } from "../tools/truncate.ts";
import { requireIntegerInRange } from "../tools/validate.ts";

/**
 * `history_search`: read back what was said earlier in this conversation.
 *
 * stella's premise is one ongoing chat, and a chat that outgrows the model's
 * window is condensed into checkpoints (ai/context-compaction.ts). The
 * summary keeps the thread, but the exact wording of the older turns — a path
 * the user gave, a decision, an error message — is no longer sent to the
 * model. This tool reads the conversation back.
 *
 * **What it searches is what the conversation shows**, and that is the whole
 * rule: the user's messages and the agent's replies (its text, and what it
 * sent with `send_chat`: cards and files). The entries are exactly the ones
 * a client draws (see agent/stella-stream.ts's `stellaEntryOf`).
 *
 * Tool calls, tool results, context publications, notifications and
 * checkpoints are the model's machinery — the conversation does not show
 * them — so they are neither searched nor returned. A tool result's exact
 * output is exactly what the model already read once; keeping it searchable
 * would turn the transcript into a log of work rather than a record of the
 * conversation, and it is the part that grows without bound.
 *
 * Two consequences follow, both deliberate:
 *
 * - The tool's own earlier results are not history: they are tool results,
 *   which this search does not read at all. A second search therefore finds
 *   what the user said instead of the first search's answer.
 * - A message that was only a card or only files still appears (with a marker
 *   for what it carried), because the conversation shows it; the card's
 *   markup is presentation, not text, so it is not searched.
 *
 * The search is over the ONE conversation that is asking: each stella agent
 * has its own transcript, and answering from another agent's would mix two
 * agents into one reply.
 *
 * The query is literal word matching, not a regular expression: a term here
 * is something the user said, so there is nothing to compile, nothing to
 * escape, and no backtracking to bound.
 */

/** Messages returned when the caller names no count. */
export const DEFAULT_HISTORY_LIMIT = 10;

/** Most messages one call returns. */
export const MAX_HISTORY_LIMIT = 100;

/** Characters kept of one message's body. */
const MAX_MESSAGE_CHARS = 1_000;

/** Total characters of all rendered messages. A count limit alone cannot
 * bound the result: 100 messages of 1,000 characters each would be a request
 * of its own. */
const MAX_RESULT_CHARS = 40_000;

/** Characters of one search term in the head line (the term itself is
 * searched whole). */
const MAX_SHOWN_TERM_CHARS = 200;

/** Characters of one message's searchable text. Cheap to compute, and it
 * bounds the work a query of many terms can cost over a long transcript. */
const MAX_SEARCH_CHARS = 100_000;

/** Whitespace, the full-width space included (a Japanese query with one
 * separates terms the same way an English query does). */
const WHITESPACE = /[\s\u3000]+/u;

/** The tool's arguments. Typed explicitly because the module's public API is
 * checked against declared types. */
const historySchema: SchemaObject<{
  query: SchemaOptional<SchemaString>;
  from: SchemaOptional<SchemaString>;
  to: SchemaOptional<SchemaString>;
  limit: SchemaOptional<SchemaInteger>;
}> = object({
  query: optional(string(
    "Words to look for, separated by spaces. A message matches when EVERY " +
      "word appears in its text, in any order and any case. Omit the query " +
      "to list what happened in the period instead.",
  )),
  from: optional(string(
    "Start of the period, YYYY-MM-DD in local time (inclusive). Omit for no " +
      "lower bound.",
  )),
  to: optional(string(
    "End of the period, YYYY-MM-DD in local time (inclusive). Omit for no " +
      "upper bound.",
  )),
  limit: optional(integer(
    `How many of the newest matching messages to return (default ` +
      `${DEFAULT_HISTORY_LIMIT}, max ${MAX_HISTORY_LIMIT}).`,
  )),
});

export interface HistorySearchTarget {
  /** The entries the conversation shows whose timestamp lies in `window`,
   * oldest first. Read from the store rather than from the model's view —
   * the turns a checkpoint replaced are exactly what this tool is for. */
  entries(window: MessageWindow): StellaEntry[];
}

/** Build the tool that searches this conversation's saved history. */
export function createHistorySearchTool(
  target: HistorySearchTarget,
): Tool<typeof historySchema> {
  return {
    name: TOOL_HISTORY_SEARCH,
    label: "History Search",
    description:
      "Search your earlier conversation with the user, including turns that " +
      "were condensed away and are no longer in your context. What is " +
      "searched is what the conversation shows: the user's messages and " +
      "yours. Tool calls and their output are not part of it. Each result " +
      "is headed with its local date and time. Each space-separated word is " +
      "matched literally and case-insensitively, and a message is returned " +
      "only when every word appears in it. `from` and `to` bound the period " +
      "by date (YYYY-MM-DD, local time, both inclusive); omit the query to " +
      "list what happened in it. Returns the newest matching messages " +
      `(default ${DEFAULT_HISTORY_LIMIT}, max ${MAX_HISTORY_LIMIT}); a ` +
      "result that would be too long is cut and says so.",
    parameters: historySchema,
    execute: (_toolCallId, params): Promise<ToolResult> => {
      const limit = requireIntegerInRange(
        "limit",
        params.limit ?? DEFAULT_HISTORY_LIMIT,
        1,
        MAX_HISTORY_LIMIT,
      );
      const window = dayWindow(params.from, params.to);
      const terms = termsOf(params.query ?? "");
      const entries = target.entries(window);
      const matches = terms.length === 0
        ? entries
        : entries.filter((entry) => matchesEvery(entry, terms));
      return Promise.resolve({
        content: [{
          type: "text",
          text: render({
            matches,
            terms,
            limit,
            from: params.from,
            to: params.to,
          }),
        }],
        details: {
          matches: matches.length,
          shown: Math.min(matches.length, limit),
        },
      });
    },
  };
}

/** Build the body the model reads: the head line, the reason when nothing
 * matched, and the messages themselves in transcript order. */
function render(input: {
  matches: readonly StellaEntry[];
  terms: readonly string[];
  limit: number;
  from: string | undefined;
  to: string | undefined;
}): string {
  const { matches, terms, limit, from, to } = input;
  const scope = describeQuery(terms);
  const period = describePeriod(from, to);
  if (matches.length === 0) return noMatchText(scope, period);

  // Newest first, so the messages that survive both budgets are the ones
  // nearest to now; the blocks are then put back in transcript order.
  const blocks: string[] = [];
  let used = 0;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (blocks.length >= limit) break;
    const block = formatEntry(matches[index]!);
    if (blocks.length > 0 && used + block.length > MAX_RESULT_CHARS) break;
    blocks.unshift(block);
    used += block.length;
  }

  const lines = [`Found ${matches.length} message(s)${scope}${period}.`];
  if (blocks.length < matches.length) {
    lines.push(
      `Showing the newest ${blocks.length}; raise limit or narrow the period ` +
        "to see the rest.",
    );
  }
  lines.push("", blocks.join("\n\n"));
  return lines.join("\n");
}

/** What the model reads when nothing matched: it has no "close enough" mode,
 * so the next call is the model's, and this says how to widen it. */
function noMatchText(scope: string, period: string): string {
  if (scope === "") {
    return "No messages have been saved in this conversation yet.";
  }

  return [
    `No message${scope}${period}.`,
    "Try fewer or shorter words, a wider period, or omit the query to list " +
    "what happened in the period.",
  ].join(" ");
}

/**
 * The text of one entry, for both searching and showing. An entry that
 * carries no words at all is described by what it carried (a prompt that was
 * an image alone is still a turn, and a card is still something the agent
 * sent), so a listing never drops a message the conversation shows.
 */
export function stellaEntryText(entry: StellaEntry): string {
  if (entry.text.trim().length > 0) return entry.text;
  const images = entry.files.filter((file) => file.image).length;
  if (images > 0) return `(${images} attached image(s), no text)`;
  if (entry.files.length > 0) {
    return `(${entry.files.length} attached file(s), no text)`;
  }
  if (entry.attachments.length > 0) {
    return `(sent ${entry.attachments.length} file(s), no text)`;
  }
  if (entry.segments.some((segment) => segment.type === "card")) {
    return "(card, no text)";
  }
  return "(no text)";
}

/** The searchable text of an entry: the words the conversation shows.
 * Cards are presentation, not words, so they are not part of it. */
function searchableText(entry: StellaEntry): string {
  return entry.text.length === 0 ? "" : truncateHead(
    entry.text,
    MAX_SEARCH_CHARS,
  ).text;
}

/** One rendered entry: the head line (local time and who) and the body, cut
 * to the length allowed and marked when it was cut. */
function formatEntry(entry: StellaEntry): string {
  const { text: body, truncated } = truncateHead(
    stellaEntryText(entry),
    MAX_MESSAGE_CHARS,
  );
  // The head names the routine when one asked: a listing that said "user"
  // would credit the user with a request they scheduled.
  const who = entry.role === "user" && entry.routine !== undefined
    ? `user (routine "${entry.routine}")`
    : entry.role;
  return `[${formatTime(entry.timestamp)}] ${who}\n${body}${
    truncated ? truncatedHeadNote("message", MAX_MESSAGE_CHARS) : ""
  }`;
}

/** Local time of a timestamp: `2026-10-29 14:03`. The window is expressed in
 * local dates as well, so a head line can be read against the bounds. */
function formatTime(timestamp: number): string {
  return formatLocalDateTime(timestamp);
}

/** Search terms: whitespace-separated and lower-cased. Japanese has no word
 * spaces, so a query without them stays one whole term — which is the
 * substring the user meant. */
function termsOf(query: string): string[] {
  return query
    .split(WHITESPACE)
    .filter((term) => term.length > 0)
    .map((term) => term.toLowerCase());
}

/** True when every term appears in the entry (case-insensitive, literal: no
 * regular expression to explain and no backtracking to bound). */
function matchesEvery(
  entry: StellaEntry,
  terms: readonly string[],
): boolean {
  const haystack = searchableText(entry).toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** The head line's description of the query. */
function describeQuery(terms: readonly string[]): string {
  if (terms.length === 0) return "";
  const shown = terms
    .map((term) =>
      term.length <= MAX_SHOWN_TERM_CHARS
        ? term
        : `${term.slice(0, MAX_SHOWN_TERM_CHARS)}…`
    )
    .join(" ");
  return ` matching "${shown}"`;
}

/** The head line's description of the period. */
function describePeriod(
  from: string | undefined,
  to: string | undefined,
): string {
  const start = cleanDay(from);
  const end = cleanDay(to);
  if (start === null && end === null) return "";
  if (start !== null && end === null) return ` since ${start} (local time)`;
  if (start === null && end !== null) return ` until ${end} (local time)`;
  if (start === end) return ` on ${start} (local time)`;
  return ` from ${start} to ${end} (local time)`;
}

interface Day {
  year: number;
  month: number;
  day: number;
}

/**
 * The period as the message store takes it: both bounds are epoch ms and
 * inclusive, and a date names the whole local day it falls on (`to` therefore
 * ends at the last millisecond of that day).
 */
function dayWindow(from?: string, to?: string): MessageWindow {
  const start = cleanDay(from);
  const end = cleanDay(to);
  const since = start === null ? null : startOfDay(parseDay(start, "from"));
  const until = end === null ? null : nextDayStart(parseDay(end, "to"));
  if (since !== null && until !== null && since >= until) {
    throw new CoreError(
      `from (${start}) is after to (${end}); both must be YYYY-MM-DD dates ` +
        "in local time",
      "invalid",
    );
  }
  return { from: since, to: until === null ? null : until - 1 };
}

/** 00:00 local time of the day. */
function startOfDay(day: Day): number {
  return new Date(day.year, day.month - 1, day.day).getTime();
}

/** 00:00 local time of the day after `day` (the end of the month rolls
 * over, which is what makes `to` inclusive). */
function nextDayStart(day: Day): number {
  return new Date(day.year, day.month - 1, day.day + 1).getTime();
}

/** A `YYYY-MM-DD` date that really exists. A day such as February 30th is
 * refused rather than rolled over into March — `Date` rolls it over, and that
 * would silently search the wrong period. */
function parseDay(value: string, field: string): Day {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new CoreError(
      `${field} must be a YYYY-MM-DD date in local time, got "${value}"`,
      "invalid",
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new CoreError(`${field} is not a real date: "${value}"`, "invalid");
  }
  return { year, month, day };
}

/** The trimmed field, or null when it was left out. */
function cleanDay(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length === 0 ? null : text;
}
