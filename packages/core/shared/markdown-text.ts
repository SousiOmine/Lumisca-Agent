/**
 * A reply's markdown as the plain text a notification can show.
 *
 * A toast has no renderer: every mark the model wrote (`##`, `**`, a fence's
 * backticks, a link's brackets) would be shown literally, so the reader is
 * handed the punctuation of a format they are not reading instead of the
 * sentence it decorates. This module keeps what the marks say and drops the
 * marks themselves.
 *
 * It is not a markdown parser — the screen has one (web/src/markdown.ts) —
 * and it does not try to be: a notification carries one line of a reply, and
 * the shapes that reach it are the block marks (headings, lists, quotes,
 * tables, fences) and the inline ones (emphasis, code, links). Anything
 * fancier is left as written, which is the honest failure: a strange string
 * in a toast is better than a sentence silently cut in half.
 */
import { segmentsText, splitChatText } from "./ui-markup/segments.ts";

/** A fence's opening line (up to three spaces, then the marker and its info
 * string). The same shape `marked` and the card splitter read, so the three
 * agree on what is a fence. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A fence's closing line: the marker alone, nothing after it. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** A horizontal rule (`---`, `***`, `___`), which is layout rather than
 * text. A setext heading's underline (`===`) is dropped the same way: the
 * words above it are already in the output. */
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_UNDERLINE = /^ {0,3}=+[ \t]*$/;

/** A table row. Only a line that starts with `|` is read as one: prose with
 * a pipe in it ("a | b") is left alone, because without the leading bar
 * there is nothing to tell the two apart. */
const TABLE_ROW = /^ {0,3}\|/;

/** A table's rule under the header (`| --- | :--: |`). */
const TABLE_RULE = /^ {0,3}\|?[ \t:|-]*-[ \t:|-]*\|[ \t:|-]*$/;

/** Where an escaped character is parked while the inline marks are removed.
 * A private-use code point is not something a reply contains, and the digits
 * let the two sides be found again. */
const ESCAPE_MARK = "\uE000";

function protectEscapes(text: string): string {
  return text.replace(
    /\\([\\`*_{}[\]()#+\-.!>~|])/g,
    (_, character: string) =>
      `${ESCAPE_MARK}${character.charCodeAt(0)}${ESCAPE_MARK}`,
  );
}

function restoreEscapes(text: string): string {
  return text.replace(/\uE000(\d+)\uE000/g, (_, code: string) =>
    String.fromCharCode(Number(code)),
  );
}

/** One line's inline marks, removed. */
function inline(text: string): string {
  const kept = protectEscapes(text);
  return restoreEscapes(
    kept
      // An image is its alt text: the picture itself cannot be drawn in a
      // toast, and the URL is not what the model meant to say.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // A link is its label. The URL is where the reader would click, and a
      // toast is not clickable.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      // Single asterisks only when they could not be arithmetic: `3 * 4 * 5`
      // has spaces just inside both marks, and is left as written.
      .replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, "$1")
      // Underscores are emphasis only between spaces or punctuation; a name
      // like `my_file_name` must not lose its separators.
      .replace(/(^|[\s(「『])_([^_\n]+)_(?=$|[\s)、。,.!?」』])/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** A reply's markdown, as readable text with its lines preserved. */
export function markdownToText(markdown: string): string {
  // Comments can span lines, so they go before the lines are walked; a card
  // would otherwise leave its markup behind (the card splitter takes whole
  // cards out, see notificationText).
  const source = markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "");

  const out: string[] = [];
  let fence: { character: string; length: number } | null = null;

  for (const line of source.split("\n")) {
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line);
      if (
        close !== null &&
        close[1]![0] === fence.character &&
        close[1]!.length >= fence.length
      ) {
        fence = null;
        continue;
      }
      // Code is literal: its marks are the code, not formatting. A fence's
      // info string ("ts", "svg") is not part of the reply's words and is
      // already gone with the opening line.
      out.push(line);
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      fence = { character: open[1]![0]!, length: open[1]!.length };
      continue;
    }

    if (line.trim() === "" || RULE.test(line) || SETEXT_UNDERLINE.test(line)) {
      continue;
    }

    if (TABLE_ROW.test(line)) {
      if (TABLE_RULE.test(line)) continue;
      const cells = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => inline(cell))
        .filter((cell) => cell !== "");
      if (cells.length > 0) out.push(cells.join(" "));
      continue;
    }

    // A quote's bar is its mark, not a quotation: the words are the quote.
    let text = line.replace(/^(?: {0,3}>[ \t]?)+/, "");
    // A heading is a line of its own; in a toast it is just the line.
    text = text.replace(/^ {0,3}#{1,6}[ \t]+/, "");
    // A list is a list: the mark becomes the bullet the reader knows (an
    // ordered item keeps its own number, which is information).
    text = text.replace(/^\s*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/, "・");
    const plain = inline(text);
    if (plain !== "") out.push(plain);
  }

  return out.join("\n");
}

/** The one line of a reply a notification carries, cut to `max` characters.
 *
 * The prose only: a card is presentation, and a toast that showed its markup
 * would be showing the agent's source rather than its words. Whitespace is
 * folded because the marks above are blocks, and a toast is a line.
 *
 * An empty answer is legitimate — a silent turn, or a reply that was only a
 * card — and the caller decides what "nothing to say" reads as. */
export function notificationText(
  markdown: string | undefined,
  max: number,
): string {
  const prose = segmentsText(splitChatText(markdown ?? ""));
  const text = markdownToText(prose).replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, max).join("");
}
