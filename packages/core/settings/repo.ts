import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseJsonc, SettingsFileError } from "./jsonc.ts";
import { atomicWriteTextFileSync, readIfExists } from "../fs.ts";
export { THEME_KEY } from "../shared/mod.ts";

export interface SettingsRepo {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  list(): Map<string, string>;
  /** Directory containing the settings file. Undefined for in-memory repos
   * (they have no file location); the machine-level AGENTS.md
   * (personalization) lives there. */
  dir(): string | undefined;
}

/** Values that parse as JSON (arrays, objects, numbers) are written natively
 * so the file stays readable by hand; everything is read back as a string,
 * which is what every consumer of SettingsRepo expects. */
function toNativeValue(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? value : parsed;
  } catch {
    return value;
  }
}

function toStoredString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Settings persisted as a single user-editable JSONC file.
 *
 * The file is read once at creation (a missing file means empty settings).
 * Every mutation re-reads it first when the bytes on disk are not the ones
 * this repo last wrote: the file is documented as hand-editable, so an edit
 * made while the app runs (or by another process) must not be overwritten by
 * the next theme change. The re-read keeps the values in memory in step with
 * what the user just wrote.
 *
 * Comments and formatting are NOT preserved when the app writes (the JSON is
 * re-serialized); the file stays valid JSON, which is also valid JSONC, so a
 * hand edit before the app starts keeps working. */
export function createFileSettingsRepo(path: string): SettingsRepo {
  let data = loadFile(path);
  /** The exact bytes last written (or read at creation). A change on disk
   * means somebody else edited the file. */
  let written = readIfExists(path);

  /** Re-read the file when it changed underneath this repo. Returns whether
   * it did. */
  const refreshIfChanged = (): boolean => {
    const current = readIfExists(path);
    if (current === written) return false;
    data = loadFile(path);
    written = current;
    return true;
  };

  const save = () => {
    const text = `${JSON.stringify(Object.fromEntries(data), null, 2)}\n`;
    atomicWriteTextFileSync(path, text, { mode: 0o600 });
    written = text;
  };

  return {
    get(key: string): string | undefined {
      const value = data.get(key);
      return value === undefined ? undefined : toStoredString(value);
    },
    set(key: string, value: string): void {
      refreshIfChanged();
      data.set(key, toNativeValue(value));
      save();
    },
    delete(key: string): void {
      const changed = refreshIfChanged();
      // `data` may have been replaced by the re-read, so the delete has to
      // act on the fresh map (and save only when something actually went).
      if (data.delete(key) || changed) save();
    },
    list(): Map<string, string> {
      const out = new Map<string, string>();
      for (const [key, value] of data) {
        out.set(key, toStoredString(value));
      }
      return out;
    },
    dir(): string {
      return dirname(path);
    },
  };
}

function loadFile(path: string): Map<string, unknown> {
  if (!existsSync(path)) return new Map();
  const parsed = parseJsonc(Deno.readTextFileSync(path), path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SettingsFileError(
      `Settings file ${path} must contain a JSON object at the top level`,
    );
  }
  return new Map(Object.entries(parsed as Record<string, unknown>));
}

/** In-memory settings store (tests and in-memory cores). */
export function createInMemorySettingsRepo(): SettingsRepo {
  const data = new Map<string, string>();
  return {
    get(key: string): string | undefined {
      return data.get(key);
    },
    set(key: string, value: string): void {
      data.set(key, value);
    },
    delete(key: string): void {
      data.delete(key);
    },
    list(): Map<string, string> {
      return new Map(data);
    },
    dir(): undefined {
      return undefined;
    },
  };
}
