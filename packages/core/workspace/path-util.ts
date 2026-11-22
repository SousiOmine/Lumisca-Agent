/**
 * Shared path helpers used by the sandbox boundary, the gitignore matcher,
 * and the workspace walkers. Single source of truth: `isWithin` guards the
 * workspace boundary, so it must never drift between implementations.
 */

import * as fsSync from "node:fs";
import { OS } from "../platform.ts";

/** Lowercase for case-insensitive comparison on Windows. */
export function normalizeCase(p: string): string {
  return OS === "windows" ? p.toLowerCase() : p;
}

/** Convert backslashes to forward slashes (portable rel paths). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** How a boundary compares paths. The default is this machine's rules;
 * a path that belongs to a container or a remote peer is POSIX and
 * case-sensitive whatever the host is. */
export interface WithinOptions {
  /** Fold case (Windows' filesystem). */
  caseInsensitive?: boolean;
  /** Compare as POSIX: forward slashes only, no host normalization. */
  posix?: boolean;
}

/** True when `candidate` is `root` itself or sits below it. The one prefix
 * rule behind every containment check: the workspace sandbox, the VM's
 * home, a lent folder's namespace and a skill directory differ only in
 * which separators and case rules apply. */
export function isWithinWith(
  root: string,
  candidate: string,
  options: WithinOptions = {},
): boolean {
  const fold = (path: string): string => {
    const normalized = options.posix === true ? path : toPosix(path);
    return options.caseInsensitive === true
      ? normalized.toLowerCase()
      : normalized;
  };
  const r = fold(root);
  const c = fold(candidate);
  if (c === r) return true;
  return c.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/** True when `candidate` is `root` itself or sits below it, under this
 * machine's case and separator rules. Both paths are canonical, so a plain
 * normalized-prefix check suffices. */
export function isWithin(root: string, candidate: string): boolean {
  return isWithinWith(root, candidate, { caseInsensitive: OS === "windows" });
}

/** True when `candidate` is `root` itself or sits below it, compared as a
 * POSIX path: a path inside a container, a lent folder's namespace, or a
 * skill directory is POSIX whatever the host's disk does. Named so a call
 * site says WHICH boundary it is checking; the rule itself is
 * {@link isWithinWith}. */
export function isWithinPosix(root: string, candidate: string): boolean {
  return isWithinWith(root, candidate, { posix: true });
}

/** Filesystem-resolved containment: when both paths resolve, the real path
 * must stay inside the real root (symlink/junction escape guard). Builds on
 * {@link isWithin} so the comparison rules cannot drift between the lexical
 * and the resolved check.
 *
 * Unresolvable targets (e.g. a command that does not exist yet) count as
 * inside; the lexical check must have run first. */
export function isWithinRealpath(root: string, path: string): boolean {
  try {
    return isWithin(fsSync.realpathSync(root), fsSync.realpathSync(path));
  } catch {
    return true;
  }
}
