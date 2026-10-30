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
export type RawChild =
  | { kind: "text"; text: string; at: number }
  | RawElement;

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
  "Choice",
  "Form",
] as const;
export const ALL_TAGS = [
  "Card",
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
      children: this.readChildren(name, depth, at),
      at,
    };
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
        this.source[this.index] !== undefined && this.source[this.index] !== "<"
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
        this.source[this.index] !== undefined && this.source[this.index] !== '"'
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
