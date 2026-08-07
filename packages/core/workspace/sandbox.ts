import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { realpathSync } from "node:fs";

export type ResolvedPath =
  | { ok: true; path: string }
  | { ok: false; reason: string };

function normalizeCase(p: string): string {
  return Deno.build.os === "windows" ? p.toLowerCase() : p;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function isWithin(root: string, candidate: string): boolean {
  const r = normalizeCase(toPosix(root));
  const c = normalizeCase(toPosix(candidate));
  if (c === r) return true;
  return c.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/**
 * Restricts file access to a set of workspace folders.
 *
 * Paths are normalized syntactically, then resolved through symlinks
 * (via realpath on existing ancestors) so that symlink escapes are
 * detected, not bypassed.
 *
 * Note: resolution and the subsequent file operation are two separate
 * syscalls, so a malicious process that can swap a symlink between them
 * (TOCTOU) could redirect the operation outside the workspace. This is
 * acceptable for a local coding agent whose model output is the primary
 * actor, but the boundary is not a security wall against concurrent
 * local attackers.
 */
export class Sandbox {
  /** Resolved, absolute workspace roots. */
  readonly roots: string[];

  constructor(folders: string[]) {
    this.roots = folders.map((f) => {
      const abs = isAbsolute(f) ? normalize(f) : normalize(join(Deno.cwd(), f));
      try {
        // Resolve 8.3 short names and symlinks on the root itself.
        return realpathSync(abs);
      } catch {
        return abs;
      }
    });
  }

  /** Resolve a user/model-supplied path against the sandbox. */
  async resolve(requested: string, cwd: string): Promise<ResolvedPath> {
    if (typeof requested !== "string" || requested.length === 0) {
      return { ok: false, reason: "Path must be a non-empty string" };
    }
    const abs = isAbsolute(requested)
      ? normalize(requested)
      : normalize(join(cwd, requested));

    const canonical = await this.canonicalize(abs);
    if (!canonical.ok) return canonical;

    for (const root of this.roots) {
      if (isWithin(root, canonical.path)) {
        return { ok: true, path: canonical.path };
      }
    }
    return {
      ok: false,
      reason: `Path is outside the workspace: ${requested}`,
    };
  }

  /** Resolve symlinks; for missing paths, canonicalize the deepest existing ancestor. */
  private async canonicalize(abs: string): Promise<ResolvedPath> {
    try {
      return { ok: true, path: await Deno.realPath(abs) };
    } catch {
      // abs does not exist yet — walk up to the deepest existing ancestor.
      return this.canonicalizeParent(abs);
    }
  }

  private async canonicalizeParent(
    abs: string,
    original = abs,
  ): Promise<ResolvedPath> {
    const parent = dirname(abs);
    if (parent === abs) {
      return { ok: false, reason: `Path does not exist: ${abs}` };
    }
    try {
      const realParent = await Deno.realPath(parent);
      // `abs` may not exist yet: re-attach the whole missing suffix of the
      // ORIGINAL path (not just the recursed argument), so deep new paths
      // (e.g. a/b/file.txt with only a/ existing) are resolved in full
      // instead of being truncated to the deepest existing ancestor + 1.
      const suffix = relative(parent, original);
      return { ok: true, path: join(realParent, suffix) };
    } catch {
      return this.canonicalizeParent(parent, original);
    }
  }

  /** Resolve a folder at workspace-creation time; it must exist. */
  static async resolveFolder(folder: string): Promise<ResolvedPath> {
    try {
      return { ok: true, path: await Deno.realPath(folder) };
    } catch {
      return { ok: false, reason: `Folder does not exist: ${folder}` };
    }
  }
}
