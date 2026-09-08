/**
 * Small filesystem and type-guard helpers shared by memory, plugins,
 * skills and models discovery. Kept tiny to avoid import cycles.
 */
import { join } from "node:path";

// ---- type guards -----------------------------------------------------------

/** True when `value` is a non-null, non-array object (i.e. a plain record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- filesystem helpers ----------------------------------------------------

/** Read a file if it exists; returns `undefined` on any filesystem error. */
export function readIfExists(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return undefined;
  }
}

/** Resolve the home-directory-dependent global directories for a given
 * sub-path (e.g. `.agents/skills` or `.agents/plugins`).
 * Returns an empty array when the home directory cannot be determined. */
export function resolveGlobalDirs(subPath: string): string[] {
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME");
  if (home === undefined || home === "") return [];
  return [join(home, subPath)];
}
