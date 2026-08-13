/**
 * Shared path helpers used by the sandbox boundary, the gitignore matcher,
 * and the workspace walkers. Single source of truth: `isWithin` guards the
 * workspace boundary, so it must never drift between implementations.
 */

/** Lowercase for case-insensitive comparison on Windows. */
export function normalizeCase(p: string): string {
  return Deno.build.os === "windows" ? p.toLowerCase() : p;
}

/** Convert backslashes to forward slashes (portable rel paths). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when `candidate` is `root` itself or sits below it. Both paths are
 * canonical, so a plain normalized-prefix check suffices. */
export function isWithin(root: string, candidate: string): boolean {
  const r = normalizeCase(toPosix(root));
  const c = normalizeCase(toPosix(candidate));
  if (c === r) return true;
  return c.startsWith(r.endsWith("/") ? r : `${r}/`);
}
