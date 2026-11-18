/**
 * Filesystem and type-guard helpers shared by memory, plugins, skills,
 * models discovery and the settings/catalog stores.
 *
 * Backend-only: this module touches `node:fs` and `node:path`, so it lives
 * outside `shared/` (which is bundled into the browser client and must stay
 * runtime-dependency free).
 */

import * as fsSync from "node:fs";
import { dirname, join } from "node:path";

// ---- type guards -----------------------------------------------------------

/** True when `value` is a non-null, non-array object (i.e. a plain record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- reads -----------------------------------------------------------------

/** Read a file if it exists; returns `undefined` on any filesystem error. */
export function readIfExists(path: string): string | undefined {
  try {
    return fsSync.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Resolve the home-directory-dependent global directories for a given
 * sub-path (e.g. `.agents/skills` or `.agents/plugins`).
 * Returns an empty array when the home directory cannot be determined. */
export function resolveGlobalDirs(subPath: string): string[] {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"];
  if (home === undefined || home === "") return [];
  return [join(home, subPath)];
}

// ---- writes ----------------------------------------------------------------

/** Create the parent directory and write `text` through a sibling temp
 * file, so a process death halfway never leaves a truncated file behind.
 * Single home for the tmp+rename shape the settings file, the MCP config
 * and the model-catalog cache all use. */
export function atomicWriteTextFileSync(
  path: string,
  text: string,
  options: { mode?: number } = {},
): void {
  fsSync.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    fsSync.writeFileSync(tmp, text, options);
    fsSync.renameSync(tmp, path);
  } finally {
    try {
      fsSync.rmSync(tmp);
    } catch {
      // Already renamed into place.
    }
  }
}
