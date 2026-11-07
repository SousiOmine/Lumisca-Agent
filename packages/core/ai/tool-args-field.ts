/**
 * One string field of a tool call's arguments, read while the model writes it.
 *
 * A provider streams a tool call's arguments as JSON text (`tool-input-delta`
 * fragments); the call itself is only complete when the JSON is. A card is
 * that JSON's `card` field, so drawing it as it is written means reading one
 * string out of a document that is still arriving — not waiting for the call
 * to finish.
 *
 * What the screen gets is the FIELD's text, already unescaped: the markup
 * inside the JSON has its quotes escaped (`\"`), and a client that pasted the
 * raw fragment into a parser would see a card with no attributes.
 */

/** What one string token of the JSON says, and where it ends.
 * `complete` is false while the closing quote has not arrived: `value` is
 * then the part that has, which is what a reader draws. */
interface StringToken {
  value: string;
  end: number;
  complete: boolean;
}

const UNESCAPE: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** The decoded value of the string starting at `start`, as far as it has
 * arrived. An escape cut in half decodes to nothing rather than to a
 * character the model did not write. */
function readStringToken(raw: string, start: number): StringToken {
  let value = "";
  let index = start + 1;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === "\\") {
      const next = raw[index + 1];
      if (next === undefined) break;
      if (next === "u") {
        const hex = raw.slice(index + 2, index + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      value += UNESCAPE[next] ?? next;
      index += 2;
      continue;
    }
    if (char === '"') return { value, end: index + 1, complete: true };
    value += char;
    index += 1;
  }
  return { value, end: raw.length, complete: false };
}

function skipSpace(raw: string, from: number): number {
  let index = from;
  while (index < raw.length && /\s/.test(raw[index]!)) index += 1;
  return index;
}

/**
 * The value of `field` in a JSON object, or null while it is not there yet.
 *
 * Only a key at the object's own depth counts: a `"card"` written inside
 * another string (the reply's own words) or inside a nested object is not
 * this call's card.
 */
export function readJsonStringField(raw: string, field: string): string | null {
  let depth = 0;
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === '"') {
      const token = readStringToken(raw, index);
      if (!token.complete) return null;
      const after = skipSpace(raw, token.end);
      const isKey = raw[after] === ":";
      if (isKey && depth === 1 && token.value === field) {
        const quote = skipSpace(raw, after + 1);
        if (raw[quote] !== '"') return null;
        return readStringToken(raw, quote).value;
      }
      index = token.end;
      continue;
    }
    if (char === "{" || char === "[" || char === "]" || char === "}") {
      depth += char === "{" || char === "[" ? 1 : -1;
    }
    index += 1;
  }
  return null;
}

/** One tool call's field, fed fragment by fragment.
 *
 * `push` answers with the text that has ARRIVED SINCE THE LAST CALL, so a
 * caller can forward it as a delta and the wire grows only by what was
 * added. What has already been returned is stable: the value is a string
 * being appended to, and an escape that is still incomplete decodes to
 * nothing until it is. */
export class ToolArgsField {
  private raw = "";
  private taken = 0;

  constructor(private readonly field: string) {}

  /** Feed the next fragment of the arguments JSON. Null when the field has
   * not started, or when this fragment added nothing to it. */
  push(fragment: string): string | null {
    if (fragment.length === 0) return null;
    this.raw += fragment;
    const value = readJsonStringField(this.raw, this.field);
    if (value === null || value.length <= this.taken) return null;
    const piece = value.slice(this.taken);
    this.taken = value.length;
    return piece;
  }
}
