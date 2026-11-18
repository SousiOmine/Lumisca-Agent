/**
 * Splitting a message's text into the prose the screen renders and the app
 * cards it draws.
 *
 * An app card is written by the model into its own reply, inside a fenced
 * code block whose info string is `ui`. The block is the JSON spec; the
 * text around it is ordinary markdown. A fence of any other language stays
 * prose, delimiters included: a code sample is not a card.
 */
import type { UiSegment } from "./types.ts";

/** The fence's info string that names an app card. */
const UI_FENCE = "ui";

/** A fence's opening line: up to three spaces, three or more backticks or
 * tildes, then the info string. The same shape `marked` reads, so the two
 * agree on what a fence is. */
function openingFence(
  line: string,
): { char: "`" | "~"; length: number; info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
  if (match === null) return null;
  const marker = match[1]!;
  const info = match[2]!.trim();
  // A backtick fence's info string may not contain a backtick (CommonMark).
  // Such a line is prose, not a fence, and markdown.ts reads it that way.
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0] as "`" | "~", length: marker.length, info };
}

/** Whether a line closes a fence opened with `open`: the same character, at
 * least as long, and nothing but spaces after it. */
function closesFence(
  line: string,
  open: { char: "`" | "~"; length: number },
): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (match === null) return false;
  const marker = match[1]!;
  return marker[0] === open.char && marker.length >= open.length;
}

/**
 * Split one message's text into its segments, in reading order.
 *
 * A `ui` fence becomes an app segment and leaves the prose. The fence runs
 * to the end of the text when it is not closed — the model is still writing
 * it — and the caller decides how to draw a partial spec.
 *
 * Text between and around the cards is trimmed at its edges: a card is a
 * block of the reply, so the blank line that separated it from the prose is
 * layout, not content.
 */
export function splitChatText(text: string): UiSegment[] {
  const segments: UiSegment[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    const joined = prose.join("\n").trim();
    if (joined.length > 0) segments.push({ type: "text", text: joined });
    prose = [];
  };

  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const open = openingFence(lines[index]!);
    if (open === null) {
      prose.push(lines[index]!);
      index += 1;
      continue;
    }

    let close = index + 1;
    while (close < lines.length && !closesFence(lines[close]!, open)) {
      close += 1;
    }
    const closed = close < lines.length;
    const body = lines.slice(index + 1, close).join("\n");

    if (open.info === UI_FENCE) {
      flushProse();
      segments.push({ type: "app", json: body });
    } else {
      // A fence of any other language is text the reader should see whole,
      // delimiters included: it is what `marked` turns into a code block or
      // a picture.
      prose = prose.concat(lines.slice(index, closed ? close + 1 : close));
    }
    index = closed ? close + 1 : close;
  }
  flushProse();
  return segments;
}

/** The prose of a message: its text segments joined, with the cards left
 * out. This is what a preview, a notification or a search reads. */
export function segmentsText(segments: readonly UiSegment[]): string {
  return segments
    .filter(
      (segment): segment is Extract<UiSegment, { type: "text" }> =>
        segment.type === "text",
    )
    .map((segment) => segment.text)
    .join("\n\n");
}
