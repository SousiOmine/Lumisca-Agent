/**
 * The one token a stella run says INSTEAD of speaking.
 *
 * A conversation shows what the agent says, and the agent therefore has to
 * distinguish two things a model normally treats as one: "here is my answer"
 * and "there is nothing to say". Written as prose both look the same, and
 * before this the only way to be silent was to call nothing at all — which
 * made every forgotten call an unanswered question (the user waited for a
 * reply that never came).
 *
 * So the default is now to speak: the assistant's text IS the message. Silence
 * becomes the deliberate act, spelled as this token, and a run that forgets to
 * use it says something rather than nothing. That is the safe side of the
 * mistake: a stray sentence is read and ignored, an answer that never arrives
 * is not.
 *
 * The rules below match Rakazo's (`packages/adapters/src/silent-reply.ts`),
 * which arrived at the same shape: a sentinel repeated per turn, glued to
 * itself, must still count as silence, and prose near the sentinel must always
 * win.
 */

/** Exact text a silent run's assistant message must be, alone. */
export const NO_RESPONSE = "NO_RESPONSE";

/** The sentinel alone, once or repeated, with any whitespace between.
 *
 * Text segments of one turn are joined with no separator, so a model that
 * re-emits the sentinel after each tool batch yields `NO_RESPONSENO_RESPONSE`.
 * That is still a silent run, not prose. */
const SENTINEL_ONLY = /^(?:NO_RESPONSE\s*)+$/;

/** True when the text is only the sentinel (once or repeated). Any prose means
 * the agent was answering, and the answer is kept. */
export function isExactNoResponse(text: string): boolean {
  return SENTINEL_ONLY.test(text.trim());
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
const WHITESPACE = /\s/;

/** The stretch of `text` that is prose: the sentinel runs at either edge are
 * removed, and the rest is left untouched.
 *
 * A token only counts as one of those runs when it ends at a word boundary: a
 * token continuing into an identifier (`NO_RESPONSE_POLICY`) is a word, so the
 * scan stops before it rather than swallowing the whole text. */
function proseRange(text: string): { start: number; end: number } {
  let cursor = text.length - text.trimStart().length;
  let start = 0;
  while (text.startsWith(NO_RESPONSE, cursor)) {
    cursor += NO_RESPONSE.length;
    if (!IDENTIFIER_CHAR.test(text[cursor] ?? "")) {
      while (cursor < text.length && WHITESPACE.test(text[cursor]!)) cursor++;
      start = cursor;
    } else if (!text.startsWith(NO_RESPONSE, cursor)) {
      break;
    }
  }
  // Scanning back from the end, so a long run of whitespace cannot make the
  // suffix backtrack.
  cursor = text.trimEnd().length;
  let end = text.length;
  while (
    cursor - NO_RESPONSE.length >= start &&
    text.endsWith(NO_RESPONSE, cursor)
  ) {
    cursor -= NO_RESPONSE.length;
    if (cursor <= start || !IDENTIFIER_CHAR.test(text[cursor - 1] ?? "")) {
      while (cursor > start && WHITESPACE.test(text[cursor - 1]!)) cursor--;
      end = cursor;
    } else if (
      !(
        cursor - NO_RESPONSE.length >= start &&
        text.endsWith(NO_RESPONSE, cursor)
      )
    ) {
      break;
    }
  }
  return { start, end };
}

/** Drop sentinel runs glued to either edge of a reply that also has prose.
 *
 * A late follow-up can leave `NO_RESPONSE` in front of a real answer; what the
 * user reads should be the answer. A reply that is ONLY the sentinel is left
 * alone — the caller decides that case (it is silence, not prose). */
export function stripStrayNoResponse(text: string): string {
  if (isExactNoResponse(text)) return text;
  const { start, end } = proseRange(text);
  return text.slice(start, end).trim();
}

/**
 * What the conversation should do with one assistant message's text.
 *
 * - `silent`: the agent said nothing on purpose (the sentinel alone).
 * - `message`: the text the user reads.
 * - `empty`: nothing to show either way (an empty message, or one that was
 *   only stray sentinels — the caller draws nothing).
 */
export type AssistantTextVerdict =
  | { kind: "silent" }
  | { kind: "message"; text: string }
  | { kind: "empty" };

/** Decide what one assistant message says to the conversation. */
export function assistantTextVerdict(text: string): AssistantTextVerdict {
  if (isExactNoResponse(text)) return { kind: "silent" };
  const visible = stripStrayNoResponse(text);
  if (visible.length === 0) return { kind: "empty" };
  return { kind: "message", text: visible };
}
