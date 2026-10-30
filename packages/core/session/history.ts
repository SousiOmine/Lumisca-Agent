import type { AgentMessage } from "../ai/types.ts";
import { CoreError } from "../errors.ts";
import type { MessageWindow, StoredMessage } from "../session/messages.ts";
import { TOOL_HISTORY_SEARCH } from "../shared/mod.ts";
import { contentText } from "../shared/content.ts";
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
 * window is condensed into checkpoints (agent/context-compaction.ts). The
 * summary keeps the thread, but the exact wording of the older turns — a path
 * the user gave, a decision, an error message — is no longer sent to the
 * model. Every message is still a row in the database, so this tool reads
 * those rows back. It is Terasuma's history_search over the same store.
 *
 * The search is over the ONE conversation that is asking: each stella agent
 * has its own transcript, and answering from another agent's would mix two
 * agents into one reply.
 *
 * Two deliberate differences from a file search. The query is literal word
 * matching, not a regular expression: a term here is something the user said,
 * so there is nothing to compile, nothing to escape, and no backtracking to
 * bound. And what is searched is what is shown (see {@link messageText}): a
 * message whose text the model can match but never read would return hits it
 * cannot use.
 */

/** Messages returned when the caller names no count. */
export const DEFAULT_HISTORY_LIMIT = 10;

/** Most messages one call returns. */
export const MAX_HISTORY_LIMIT = 100;

/** Characters kept of one message's body. */
const MAX_MESSAGE_CHARS = 1_000;

/** Characters kept of one tool result. Its head is what says which command
 * ran; the rest is output nobody searches a conversation for. */
const MAX_TOOL_RESULT_CHARS = 500;

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
  /** The messages of the conversation that is asking, in transcript order,
   * read from the database rather than from the model's view — the turns a
   * checkpoint replaced are exactly what this tool is for. */
  messages(window: MessageWindow): StoredMessage[];
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
      "were condensed away and are no longer in your context. Each " +
      "space-separated word is matched literally and case-insensitively, and " +
      "a message is returned only when every word appears in it. `from` and " +
      "`to` bound the period by date (YYYY-MM-DD, local time, both " +
      "inclusive); omit the query to list what happened in it. Returns the " +
      `newest matching messages (default ${DEFAULT_HISTORY_LIMIT}, max ` +
      `${MAX_HISTORY_LIMIT}); a result that would be too long is cut and ` +
      "says so.",
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
      const stored = target.messages(window).filter(isNotOwnResult);
      const matches = terms.length === 0
        ? stored
        : stored.filter((row) => matchesEvery(row.message, terms));
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

/** A message the tool itself produced is not history to search: its result
 * is a rendering of earlier messages, so returning it would echo the words
 * the caller just asked for — and a second search would find the first one's
 * answer instead of what was said. */
function isNotOwnResult(row: StoredMessage): boolean {
  return !(
    row.message.role === "toolResult" &&
    row.message.toolName === TOOL_HISTORY_SEARCH
  );
}

/** Build the body the model reads: the head line, the reason when nothing
 * matched, and the messages themselves in transcript order. */
function render(input: {
  matches: readonly StoredMessage[];
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
    const block = formatMessage(matches[index]!);
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

/** A message as the tool reads it: who spoke, and the text that is both
 * searched and shown. */
interface MessageText {
  /** The speaker, as the head line names it ("user", "assistant",
   * "tool result: bash", ...). */
  speaker: string;
  body: string;
}

/** The text of one message, or undefined for a role that carries none (a
 * user message with an image and no words, for example). */
function messageText(message: AgentMessage): MessageText | undefined {
  switch (message.role) {
    case "user": {
      const body = contentText(message.content).trim();
      // A prompt can be images only: the words are empty but the turn is
      // still part of what happened, and "nothing" would read as a hole.
      if (body.length === 0) {
        return { speaker: "user", body: "(attached image, no text)" };
      }
      return { speaker: "user", body };
    }
    case "mode":
      return { speaker: "user", body: message.fullPrompt };
    case "assistant": {
      const parts: string[] = [];
      const text = contentText(message.content).trim();
      if (text.length > 0) parts.push(text);
      // The calls name what the turn did; their arguments and results are
      // what a search is not after.
      const calls = message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => block.name);
      if (calls.length > 0) parts.push(`(tool calls: ${calls.join(", ")})`);
      return parts.length === 0
        ? undefined
        : { speaker: "assistant", body: parts.join("\n") };
    }
    case "toolResult": {
      const text = contentText(message.content).trim();
      return {
        speaker: `tool result: ${message.toolName}`,
        body: text.length === 0 ? "(no text)" : text,
      };
    }
    case "notification":
      return {
        speaker: "system notification",
        body: message.body.length === 0
          ? message.title
          : `${message.title}\n${message.body}`,
      };
    case "context":
    case "checkpoint":
      return { speaker: message.role, body: message.body };
    default:
      return undefined;
  }
}

/** One rendered message: the head line (local time and who) and the body,
 * cut to the length its kind allows and marked when it was cut. */
function formatMessage(row: StoredMessage): string {
  const text = messageText(row.message);
  if (text === undefined) return "";

  const isToolResult = text.speaker.startsWith("tool result:");
  const max = isToolResult ? MAX_TOOL_RESULT_CHARS : MAX_MESSAGE_CHARS;
  const { text: body, truncated } = truncateHead(text.body, max);
  return `[${formatTime(row.timestamp)}] ${text.speaker}\n${body}${
    truncated ? truncatedHeadNote("message", max) : ""
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

/** True when every term appears in the message (case-insensitive, literal:
 * no regular expression to explain and no backtracking to bound). */
function matchesEvery(
  message: AgentMessage,
  terms: readonly string[],
): boolean {
  const text = messageText(message);
  if (text === undefined) return false;
  const haystack = truncateHead(text.body, MAX_SEARCH_CHARS).text
    .toLowerCase();
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
