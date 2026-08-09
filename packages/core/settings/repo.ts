import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseJsonc, SettingsFileError } from "./jsonc.ts";
export { THEME_KEY } from "../shared.ts";

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

/** Settings persisted as a single user-editable JSONC file. The file is
 * loaded once at creation (a missing file means empty settings); every
 * mutation rewrites the whole file atomically (tmp + rename). */
export function createFileSettingsRepo(path: string): SettingsRepo {
  const data = loadFile(path);

  const save = () => {
    Deno.mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    try {
      Deno.writeTextFileSync(
        tmp,
        `${JSON.stringify(Object.fromEntries(data), null, 2)}\n`,
        { mode: 0o600 },
      );
      Deno.renameSync(tmp, path);
    } finally {
      try {
        Deno.removeSync(tmp);
      } catch {
        // Already renamed into place.
      }
    }
  };

  return {
    get(key: string): string | undefined {
      const value = data.get(key);
      return value === undefined ? undefined : toStoredString(value);
    },
    set(key: string, value: string): void {
      data.set(key, toNativeValue(value));
      save();
    },
    delete(key: string): void {
      if (data.delete(key)) save();
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
