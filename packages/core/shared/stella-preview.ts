/**
 * Frontend-safe shared helpers (see shared/mod.ts): the second line of an
 * agent's row in stella's sidebar.
 *
 * A list of people to talk to is scanned, not read: the name says who, and
 * the line under it says what they last said. That is the one thing a
 * message app's list shows and this one did not — its rows said only when
 * the conversation was last OPENED, which is a fact about the reader, not
 * about the conversation.
 *
 * What the line may show is what the conversation shows, with one exception: a
 * routine's prompt is named here although the conversation does not draw it
 * (see previewOf). Otherwise the rule is whole: the entry a client draws (see
 * the core's
 * agent/stella-stream.ts) — the user's words and the agent's reply (its final
 * text, and what `send_chat` sent with it). Its narration, tool calls, their
 * output and the context publications the model runs on are not part of it. The server
 * projects the newest row through that same function, so the list cannot
 * show something the conversation would not (the same reason
 * `history_search` projects its results rather than reading rows).
 *
 * Two callers share this module, and they MUST agree:
 *
 * - the server, when it answers the agent list (`GET /stella/agents`, one
 *   preview per agent, read from the store);
 * - the browser, when the conversation that is open receives a new entry, so
 *   that row's second line updates at once instead of up to a refresh later.
 *
 * The text is folded to a single line here rather than in CSS because the
 * line is also a payload: a message can be a whole markdown document, and a
 * list that carried every agent's last message whole would pay for it on
 * every refresh. The fold is presentational (markers and emphasis), so what
 * remains is what a reader would have seen emphasised in the bubble.
 */
import type { StellaEntry } from "../domain/stella-conversation.ts";

/** What a sidebar row says under the name.
 *
 * One shape per kind of message, not one string, because the line is drawn
 * differently: words are the message itself, while a message that was only
 * files or only a card is described (the count, or its kind) — the words
 * "3 files" are a caption, and a client that received them as text could not
 * tell them from something the user wrote. */
export type StellaPreview =
  /** A message with words. `text` is already folded to one line and bounded
   * by {@link PREVIEW_TEXT_CHARS}. */
  | { kind: "text"; text: string; at: number }
  /** A message that carried files and no words: how many it carried. */
  | { kind: "files"; count: number; at: number }
  /** A message that showed only a card (no words, no files): the card's own
   * markup is presentation, and a table of it in a 216px row would be
   * noise, so the row names the thing instead. */
  | { kind: "card"; at: number }
  /** A request a routine ran, named by the routine. It is on the user's side
   * of the conversation but the user did not write it, so the row says what
   * asked instead of quoting the request as their last words. */
  | { kind: "routine"; name: string; at: number };

/** Most characters of a message kept as a preview.
 *
 * The row is one line and ellipsised by the stylesheet, so this is a payload
 * bound rather than a display width: 200 characters of a Japanese message is
 * already far wider than the row, while a message that is a whole document
 * (a report an agent wrote) is folded to what a reader could have seen of its
 * beginning. */
export const PREVIEW_TEXT_CHARS = 200;

/** The second line for one conversation entry, or null when the entry has
 * nothing a row could say (a prompt that was an image alone says "1 file",
 * which it carries; an entry this build cannot describe says nothing).
 *
 * `at` is the entry's own timestamp: the list orders by it, so it travels
 * with the preview instead of being read from the agent row (which records
 * when the conversation was opened, not when it was last spoken in). */
export function previewOf(entry: StellaEntry): StellaPreview | null {
  // A routine's request is not something the user said (see #37): the row
  // names the routine rather than putting the scheduled words in their
  // mouth. The conversation itself does not draw the prompt at all (it is the
  // routine's standing instruction), so this line is where the routine stays
  // visible.
  if (entry.routine !== undefined) {
    return { kind: "routine", name: entry.routine, at: entry.timestamp };
  }
  const text = previewText(entry.text);
  if (text.length > 0) return { kind: "text", text, at: entry.timestamp };
  // A message that carried files is the user's attachment or what the agent
  // handed over; either way the row says "1 file" rather than nothing.
  if (entry.files.length > 0) {
    return { kind: "files", count: entry.files.length, at: entry.timestamp };
  }
  if (entry.attachments.length > 0) {
    return {
      kind: "files",
      count: entry.attachments.length,
      at: entry.timestamp,
    };
  }
  // A card without words. The row names it; the conversation shows it.
  if (entry.segments.some((segment) => segment.type === "card")) {
    return { kind: "card", at: entry.timestamp };
  }
  return null;
}

/** Whether two previews say the same thing (a client uses it to keep the
 * previous array object, so a no-op refresh does not re-render the list). */
export function samePreview(
  a: StellaPreview | null,
  b: StellaPreview | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind || a.at !== b.at) return false;
  switch (a.kind) {
    case "text":
      return b.kind === "text" && a.text === b.text;
    case "files":
      return b.kind === "files" && a.count === b.count;
    case "card":
      return true;
    case "routine":
      return b.kind === "routine" && a.name === b.name;
  }
}

/** One message's text as a row shows it: the reader's line, not the
 * markdown.
 *
 * Markers are dropped rather than kept, because they are syntax for a
 * renderer that is not there: a heading's `##`, a bullet's `-`, a fence's
 * backticks and an emphasis marker would otherwise be the first characters
 * of half the rows. Inline code keeps its words and loses its backticks; a
 * link keeps its label.
 *
 * One rule is deliberately conservative: a lone `*` or `_` inside a word is
 * kept (`snake_case`, `2*3`), because removing it changes what the message
 * said. Emphasis is only removed when it marks a span (`**bold**`,
 * `__bold__`, `` `code` ``). */
export function previewText(text: string): string {
  return truncatePreview(foldLines(text));
}

/** The first line's worth of a message: block markers out, whitespace
 * folded, then cut at {@link PREVIEW_TEXT_CHARS} (on a code point boundary,
 * with an ellipsis, so a cut never ends mid-surrogate). */
function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_TEXT_CHARS) return text;
  const cut = [...text].slice(0, PREVIEW_TEXT_CHARS).join("");
  return `${cut}…`;
}

/** Drop what a renderer turns into structure and join what is left. */
function foldLines(source: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    // A fence's own line is markup; the code inside it is words a reader can
    // see in the bubble, so those lines are kept.
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push(line);
      continue;
    }
    // A table's rule line (`|---|---|`) is markup with no words of its own.
    if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")) continue;
    const stripped = line
      // Heading, blockquote, bullet and ordered-list markers at the start of
      // a line.
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d{1,3}[.)]\s+/, "")
      // A horizontal rule is a whole line of markers.
      .replace(/^(?:[-*_]\s*){3,}$/, "");
    lines.push(stripped);
  }
  return foldInline(lines.join(" "));
}

/** Inline markers, and the whitespace fold that makes the result one line. */
function foldInline(text: string): string {
  return (
    text
      // Images and links keep their label: it is the words the message read.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Emphasis and inline code lose their markers, keep their text.
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      // Table cells: the pipes are the table's syntax, not the sentence's.
      .replace(/\s*\|\s*/g, " ")
      .replace(/[\s\u3000]+/g, " ")
      .trim()
  );
}

/** What a sidebar row needs to know about the agent itself: the label, the
 * picture, and when it was last spoken to.
 *
 * The fields a row PRESENTS, not the whole row of the store: this module is
 * bundled into the browser and must not reach into stella/agents.ts (the
 * SQLite-backed repo). stella/agents.ts extends this shape, so the server's
 * answer and the client's type still cannot disagree.
 */
export interface StellaAgentSummaryBase {
  /** The agent's id: the row's identity, and the last tie-break of the
   * order. */
  id: string;
  /** The label the user gave it (the conversation header prints it too). */
  name: string;
  /** The icon store's file name, or "" when the agent has no picture. */
  icon: string;
  /** The model this agent's conversation runs on, or null to use the app's
   * default model. The edit dialog reads it from here: the agent list is the
   * only read a client has before a conversation is opened, and choosing the
   * model must not require opening one. */
  model: { provider: string; modelId: string } | null;
  /** When the user last talked to it (the "most recently used" order). */
  updatedAt: number;
  /** When the agent was created: the last tie-break of the row order, so two
   * conversations that have said nothing still sort stably. */
  createdAt: number;
}

/** One row of the agent list: the agent and what its conversation last
 * said. Defined here beside the preview so the route and the client agree on
 * the shape (the server answers it, the sidebar draws it). */
export interface StellaAgentSummary extends StellaAgentSummaryBase {
  /** The newest thing the conversation shows, or null when nothing has been
   * said yet (a fresh agent: the row then has one line, like a message app's
   * row for someone you have not talked to). */
  preview: StellaPreview | null;
}

/** Why one row comes before another.
 *
 * A message app lists conversations by recency, and the time it shows is the
 * last message's — so a row that mentions a time but sits somewhere the
 * times do not explain is the thing this order removes. A conversation
 * nothing has been said in yet has no such time, so those rows follow the
 * ones that do (most recently used among themselves), which keeps the
 * people you have never talked to out of the way without hiding them.
 *
 * The order is total (`createdAt`, then id): two rows with the same
 * millisecond must not swap places between two refreshes, because the list
 * re-reads on a timer.
 */
export function compareAgentRows(
  a: StellaAgentSummary,
  b: StellaAgentSummary,
): number {
  const at = a.preview?.at ?? null;
  const bt = b.preview?.at ?? null;
  if (at !== null && bt !== null && at !== bt) return bt - at;
  if (at !== null && bt === null) return -1;
  if (at === null && bt !== null) return 1;
  if (at === null && bt === null && a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Put one agent's row into the list, as the server just answered it.
 *
 * Two client actions end with a row the list has not read yet: an edit, whose
 * answer carries the new name, picture or model, and a create, whose answer
 * carries the whole agent. Neither needs the list re-read — the answer already
 * says what the row says — and for a create a re-read would be too late: the
 * new conversation is opened (the address names it) before any re-read can
 * land, and a list that does not hold the row yet makes that address look like
 * an agent that does not exist (App.tsx sends such an address back to the
 * list). Taking the row from the answer is what keeps the two in step.
 *
 * The preview is the row's own, not the answer's: a name or a picture is not
 * something the conversation said, so an edit keeps the line it had. A new
 * agent has said nothing yet, so its row has none.
 *
 * The result is ordered by the same rule the server uses
 * ({@link compareAgentRows}), so a row added here sits where a re-read would
 * have put it — a list that reorders when the next refresh lands is a list
 * that moves under the reader's eye for no reason.
 */
export function withAgentRow(
  rows: readonly StellaAgentSummary[],
  agent: StellaAgentSummaryBase,
): StellaAgentSummary[] {
  const previous = rows.find((row) => row.id === agent.id);
  const row: StellaAgentSummary = {
    ...agent,
    preview: previous?.preview ?? null,
  };
  const next =
    previous === undefined
      ? [...rows, row]
      : rows.map((existing) => (existing.id === agent.id ? row : existing));
  return next.sort(compareAgentRows);
}
