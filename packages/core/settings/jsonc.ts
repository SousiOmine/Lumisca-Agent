/** JSONC (JSON with comments and trailing commas) support for the settings
 * file. The app writes plain JSON (which is valid JSONC); parsing accepts
 * the relaxed syntax so the file stays hand-editable. */

/** A settings file that cannot be parsed, or is not a JSON object. */
export class SettingsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsFileError";
  }
}

function isJsonWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** A transformation applied to one position outside string literals:
 * the replacement text and how many characters to consume (0 = drop). */
type OutsideTransform = (
  text: string,
  index: number,
) => { consumed: number; replaced: string };

/** Walk a JSONC document, copying string literals verbatim and applying
 * `transform` to everything outside them. Shared by the comment stripper
 * and the trailing-comma remover so the literal-copying loop lives once. */
function transformOutsideStrings(
  text: string,
  transform: OutsideTransform,
): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      // Copy the string literal verbatim (escapes included).
      out += ch;
      i++;
      while (i < n) {
        const c = text[i]!;
        out += c;
        i++;
        if (c === "\\" && i < n) {
          out += text[i]!;
          i++;
        } else if (c === '"') {
          break;
        }
      }
    } else {
      const { consumed, replaced } = transform(text, i);
      out += replaced;
      i += consumed;
    }
  }
  return out;
}

/** Remove // and /* *\/ comments, keeping string literals intact. */
function stripComments(text: string): string {
  return transformOutsideStrings(text, (t, i) => {
    if (t[i] === "/" && t[i + 1] === "/") {
      let j = i;
      while (j < t.length && t[j] !== "\n") j++;
      return { consumed: j - i, replaced: "" };
    }
    if (t[i] === "/" && t[i + 1] === "*") {
      let j = i + 2;
      while (j < t.length && !(t[j] === "*" && t[j + 1] === "/")) j++;
      return { consumed: j - i + 2, replaced: "" };
    }
    return { consumed: 1, replaced: t[i]! };
  });
}

/** Drop commas that precede only whitespace and a closing bracket, keeping
 * string literals intact. */
function removeTrailingCommas(text: string): string {
  return transformOutsideStrings(text, (t, i) => {
    if (t[i] !== ",") return { consumed: 1, replaced: t[i]! };
    let j = i + 1;
    while (j < t.length && isJsonWhitespace(t[j]!)) j++;
    if (t[j] === "}" || t[j] === "]") {
      return { consumed: j - i, replaced: "" };
    }
    return { consumed: 1, replaced: "," };
  });
}

/** Convert a JSON.parse error position into a line:column hint. */
function describeLocation(text: string, message: string): string {
  const match = message.match(/position (\d+)/);
  if (!match) return "";
  const pos = Number(match[1]);
  let line = 1;
  let col = 0;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return ` (line ${line}, column ${col + 1})`;
}

/** Parse a JSONC document into a plain JSON value. Throws
 * SettingsFileError on syntax errors, pointing at the offending position. */
export function parseJsonc(text: string, path?: string): unknown {
  const cleaned = removeTrailingCommas(stripComments(text));
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const where = path === undefined ? "" : ` in ${path}`;
    throw new SettingsFileError(
      `Invalid settings JSONC${where}: ${message}${
        describeLocation(cleaned, message)
      }`,
    );
  }
}
