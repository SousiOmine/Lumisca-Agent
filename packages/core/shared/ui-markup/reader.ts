import { UI_MARKUP_LIMITS } from "./limits.ts";

/**
 * Tokenizing and parsing of the UI markup: read a string into a tree of tags
 * (RawElement), which build.ts then rearranges into the grammar's card.
 */

export class MarkupError extends Error {
  readonly at: number;

  constructor(at: number, message: string) {
    super(message);
    this.name = "MarkupError";
    this.at = at;
  }
}

/** One attribute written in a tag. A value-less boolean attribute has a null
 * `value`. */
export type RawAttribute = {
  name: string;
  value: string | null;
  at: number;
};

/** The content of a tag: text, or a child element. */
export type RawChild = { kind: "text"; text: string; at: number } | RawElement;

/** The tree of tags, before the grammar is checked. */
export type RawElement = {
  kind: "element";
  name: string;
  attrs: RawAttribute[];
  children: RawChild[];
  at: number;
};

export const BLOCK_TAGS = [
  "Text",
  "List",
  "Table",
  "Flow",
  "Metric",
  "Choice",
  "Form",
  "Stack",
  "Columns",
  "Grid",
  "Repeat",
  "If",
] as const;
export const ALL_TAGS = [
  "Card",
  "Data",
  ...BLOCK_TAGS,
  "Item",
  "Row",
  "Cell",
  "Node",
  "Edge",
  "Option",
  "Field",
] as const;

/** Read the card markup into a tree of tags and text. A grammar mistake is a
 * MarkupError. */
export function parseDocument(source: string): RawElement {
  return new MarkupReader(source).readDocument();
}

/**
 * Unwind a string into a tree of tags and text.
 * Which tag may sit where is checked by buildView; this only looks at the
 * shape.
 */
class MarkupReader {
  private index = 0;

  constructor(private readonly source: string) {}

  readDocument(): RawElement {
    this.skipSpace();
    if (this.source[this.index] === undefined) {
      this.bad("the markup is empty; it needs one <Card>");
    }
    if (this.source[this.index] !== "<") {
      this.bad("the markup must start with <Card>");
    }

    const root = this.readElement(1);
    this.skipSpace();
    if (this.index < this.source.length) {
      this.bad("unexpected text after the closing </Card>");
    }
    return root;
  }

  private readElement(depth: number): RawElement {
    const at = this.index;
    if (depth > UI_MARKUP_LIMITS.depth) {
      this.bad(
        `elements are nested deeper than ${UI_MARKUP_LIMITS.depth} levels`,
        at,
      );
    }

    this.index += 1; // "<"
    if (this.source[this.index] === "/") this.bad("unexpected closing tag", at);
    if (this.source[this.index] === "!") {
      this.bad("comments and declarations are not supported", at);
    }

    const name = this.readName();
    const attrs: RawAttribute[] = [];

    for (;;) {
      this.skipSpace();
      const char = this.source[this.index];
      if (char === undefined) this.bad(`tag <${name}> is not closed`, at);

      if (char === ">") {
        this.index += 1;
        break;
      }
      if (char === "/") {
        if (this.source[this.index + 1] !== ">") {
          this.bad('expected "/>" to close the tag');
        }
        this.index += 2;
        return { kind: "element", name, attrs, children: [], at };
      }
      attrs.push(this.readAttribute());
    }

    return {
      kind: "element",
      name,
      attrs,
      children:
        name === "Data"
          ? this.readRawData(at)
          : this.readChildren(name, depth, at),
      at,
    };
  }

  /**
   * The body of `<Data>`: everything up to `</Data>`, untouched.
   *
   * The body is JSON, and a JSON string may hold `<` or `&`; reading it as
   * markup would refuse ordinary text ("a < b") and turn entities inside
   * strings into characters the model did not write. The one shape a card
   * cannot carry is the literal `</Data>`.
   */
  private readRawData(at: number): RawChild[] {
    const textAt = this.index;
    const end = this.source.indexOf("</Data>", this.index);
    if (end === -1) this.bad("tag <Data> is not closed with </Data>", at);
    this.index = end + "</Data>".length;
    return [{ kind: "text", text: this.source.slice(textAt, end), at: textAt }];
  }

  private readChildren(name: string, depth: number, at: number): RawChild[] {
    const children: RawChild[] = [];

    for (;;) {
      const char = this.source[this.index];
      if (char === undefined) {
        this.bad(`tag <${name}> is not closed with </${name}>`, at);
      }

      if (char === "<") {
        if (this.source[this.index + 1] === "/") {
          const closeAt = this.index;
          this.index += 2;
          const closing = this.readName();
          if (closing !== name) {
            this.bad(`expected </${name}> but found </${closing}>`, closeAt);
          }
          this.skipSpace();
          if (this.source[this.index] !== ">") {
            this.bad('expected ">" to close the tag', closeAt);
          }
          this.index += 1;
          return children;
        }
        if (this.source[this.index + 1] === "!") {
          this.bad("comments and declarations are not supported");
        }
        // A "<" in prose cannot be told apart from the start of a tag: write
        // it as an entity.
        if (!isLetter(this.source[this.index + 1])) {
          this.bad('write "<" in text as &lt;, or close the tag with "/>"');
        }
        children.push(this.readElement(depth + 1));
        continue;
      }

      const textAt = this.index;
      this.index += 1;
      while (
        this.source[this.index] !== undefined &&
        this.source[this.index] !== "<"
      ) {
        this.index += 1;
      }
      children.push({
        kind: "text",
        text: decodeEntities(this.source.slice(textAt, this.index), textAt),
        at: textAt,
      });
    }
  }

  private readName(): string {
    const start = this.index;
    if (!isLetter(this.source[this.index])) this.bad("expected a tag name");
    while (isNameChar(this.source[this.index])) this.index += 1;
    return this.source.slice(start, this.index);
  }

  private readAttribute(): RawAttribute {
    const at = this.index;
    if (!isLetter(this.source[this.index])) {
      this.bad("expected an attribute name");
    }

    const start = this.index;
    while (isAttributeChar(this.source[this.index])) this.index += 1;
    const name = this.source.slice(start, this.index);

    this.skipSpace();
    let value: string | null = null;
    if (this.source[this.index] === "=") {
      this.index += 1;
      this.skipSpace();
      if (this.source[this.index] !== '"') {
        this.bad(`attribute "${name}" must use double quotes`);
      }
      this.index += 1;

      const valueAt = this.index;
      while (
        this.source[this.index] !== undefined &&
        this.source[this.index] !== '"'
      ) {
        this.index += 1;
      }
      if (this.source[this.index] === undefined) {
        this.bad(`attribute "${name}" is not closed`, at);
      }
      value = decodeEntities(this.source.slice(valueAt, this.index), valueAt);
      this.index += 1;
    }

    return { name, value, at };
  }

  private skipSpace(): void {
    while (isSpace(this.source[this.index])) this.index += 1;
  }

  private bad(message: string, at = this.index): never {
    fail(at, message);
  }
}

/** Throw a grammar mistake with its position (an index into the string). */
export function fail(at: number, message: string): never {
  throw new MarkupError(at, message);
}

/** Turn a string index into a line and column. */
export function positionOf(
  source: string,
  index: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;

  const end = Math.min(index, source.length);
  for (let cursor = 0; cursor < end; cursor += 1) {
    if (source[cursor] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

/** Entities. Only these five are accepted. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode the entities of text and attribute values. An unknown spelling is
 * refused at its position. */
export function decodeEntities(raw: string, at: number): string {
  if (!raw.includes("&")) return raw;

  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (char !== "&") {
      out += char;
      continue;
    }

    const match = /^&([a-z]+);/.exec(raw.slice(index));
    if (match === null) {
      fail(
        at + index,
        'write "&" as &amp; and use one of &lt; &gt; &amp; &quot; &apos;',
      );
    }

    const name = match[1] ?? "";
    const decoded = ENTITIES[name];
    if (decoded === undefined) {
      fail(
        at + index,
        `unknown entity "&${name};" (use &lt; &gt; &amp; &quot; &apos;)`,
      );
    }
    out += decoded;
    index += match[0].length - 1;
  }

  return out;
}

function isSpace(value: string | undefined): boolean {
  return value === " " || value === "\n" || value === "\t" || value === "\r";
}

function isLetter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z]/.test(value);
}

function isNameChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9]/.test(value);
}

function isAttributeChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9-]/.test(value);
}

/** One tag met while walking a card. `end` is the index just past its ">". */
type Tag = {
  /** The name written after "<"; "" when a name was not what came next. */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
};

/**
 * Walk the tags of a card, one at a time, without checking the grammar.
 *
 * `<Data>` is taken whole: its body is JSON, where a string may hold "<" or
 * "&", and reading it as tags would find tags the model never wrote. A tag
 * that is still being written ends the walk — nothing after it can be read
 * yet.
 */
function* walkTags(source: string): Generator<Tag> {
  let index = 0;

  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open < 0) return;
    const close = source.indexOf(">", open);
    if (close < 0) return; // the tag is still being written

    const body = source.slice(open + 1, close);
    index = close + 1;

    if (body.startsWith("/")) {
      yield {
        name: body.slice(1).trim(),
        closing: true,
        selfClosing: false,
        end: index,
      };
      continue;
    }

    const selfClosing = body.endsWith("/");
    const name = body.replace(/\/$/, "").trim().split(/\s/)[0] ?? "";

    if (name === "Data" && !selfClosing) {
      const end = source.indexOf("</Data>", index);
      if (end < 0) return; // the data is still arriving; nothing after it
      index = end + "</Data>".length;
      continue;
    }
    yield { name, closing: false, selfClosing, end: index };
  }
}

/**
 * The longest prefix of a card that ends at a complete block, with `</Card>`
 * closed onto it — or null while there is none.
 *
 * A model writing a card sends it in fragments, and a client that drew only
 * finished cards would show nothing until the last one arrived. This finds
 * what can be drawn now: everything up to the last block that closed, with
 * the tags still open outside it dropped. `<Data>` is taken whole — the JSON
 * body is unreadable until it ends, and the blocks that read it follow it.
 *
 * A prefix that is not the beginning of a well-formed card (a stray closing
 * tag, a root that is not `Card`) answers null rather than a guess.
 */
export function cardPrefix(source: string): string | null {
  const stack: string[] = [];
  let closedAt = -1;

  for (const tag of walkTags(source)) {
    if (tag.closing) {
      if (stack.pop() !== tag.name) return null;
      if (stack.length === 1) closedAt = tag.end;
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(tag.name)) return null;
    if (tag.selfClosing) {
      if (stack.length === 1) closedAt = tag.end;
      continue;
    }
    if (stack.length === 0 && tag.name !== "Card") return null;
    stack.push(tag.name);
  }

  return closedAt < 0 ? null : `${source.slice(0, closedAt)}</Card>`;
}

/**
 * Where the card written in `source` ends: the index just past the tag that
 * closes its root, or -1 while that tag has not been written.
 *
 * A reply often keeps talking inside the fence after `</Card>` — the model
 * writes the closing tag and then goes on — so the text left in the block is
 * the reply's words, not part of the card. The card is over at that tag
 * (./segments.ts hands the rest back as prose rather than losing it).
 *
 * The walk starts at whatever comes first: the end found is the end of the
 * first element the source holds, and the caller decides what that means
 * (./segments.ts asks only about a block that opens with `<Card`).
 */
export function cardEnd(source: string): number {
  let depth = 0;

  for (const tag of walkTags(source)) {
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) return tag.end;
      continue;
    }
    if (tag.selfClosing) {
      if (depth === 0) return tag.end;
      continue;
    }
    depth += 1;
  }

  return -1;
}
