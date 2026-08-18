/** JSONC (JSON with comments and trailing commas) support for the settings
 * file. The app writes plain JSON (which is valid JSONC); parsing accepts
 * the relaxed syntax so the file stays hand-editable. Parsing is delegated
 * to @std/jsonc; this module only shapes its errors. */

import { parse } from "@std/jsonc";

/** A settings file that cannot be parsed, or is not a JSON object. */
export class SettingsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsFileError";
  }
}

/** Convert a JSON.parse error position into a line:column hint. The std
 * jsonc parser reports the failing position as "at position N" in its
 * message. */
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
  try {
    return parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const where = path === undefined ? "" : ` in ${path}`;
    throw new SettingsFileError(
      `Invalid settings JSONC${where}: ${message}${
        describeLocation(text, message)
      }`,
    );
  }
}
