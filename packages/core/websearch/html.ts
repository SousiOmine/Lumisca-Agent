/**
 * HTML → readable text.
 *
 * Used by the direct fetch (for providers without a page API) and to clean
 * a search result's excerpt. Deliberately not an HTML parser: tags and
 * entities are stripped, block boundaries become line breaks, and the
 * result is whitespace-normalised. Fidelity is traded for a small, dependency
 * free, side-effect free function both the server and its tests can run.
 */

const TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;

/** Elements whose content is never readable text; dropped with their tags. */
const REMOVED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "svg",
  "template",
  "iframe",
  "canvas",
  "head",
  "title",
] as const;

/** Closing tags that end a line. */
const BLOCK_END_PATTERN =
  /<\/(?:p|div|li|tr|h[1-6]|blockquote|pre|table|thead|tbody|section|article|header|footer|main|aside|nav|figure|figcaption|dl|dt|dd)\s*>/gi;

const BR_PATTERN = /<br\b[^>]*\/?>/gi;
const TAG_PATTERN = /<[^>]*>/g;
const WHITESPACE_PATTERN = /[ \t\f\v\u00a0]+/g;
const BLANK_LINES_PATTERN = /\n{3,}/g;

/** The named entities pages actually use; anything else stays as written
 * rather than being guessed. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** The page's title, or null when it has none. */
export function pageTitle(html: string): string | null {
  const match = TITLE_PATTERN.exec(html);
  if (match === null) return null;

  const title = decodeEntities(match[1] ?? "")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
  return title.length === 0 ? null : title;
}

/** The readable text of an HTML document. */
export function htmlToText(html: string): string {
  let text = html;

  for (const tag of REMOVED_ELEMENTS) {
    text = text.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
      "",
    );
  }

  text = text.replace(BLOCK_END_PATTERN, "\n");
  text = text.replace(BR_PATTERN, "\n");
  text = text.replace(TAG_PATTERN, "");
  text = decodeEntities(text);

  return normalize(text);
}

/** Turn entities back into characters. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-f]+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const hex = entity[1]?.toLowerCase() === "x";
        const digits = hex ? entity.slice(2) : entity.slice(1);
        const code = Number.parseInt(digits, hex ? 16 : 10);
        if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
          return match;
        }

        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }

      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

/** Collapse inner whitespace, keep at most one blank line, trim. */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(WHITESPACE_PATTERN, " ").trim())
    .join("\n")
    .replace(BLANK_LINES_PATTERN, "\n\n")
    .trim();
}
