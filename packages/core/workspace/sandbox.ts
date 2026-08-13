import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from "node:path";
import { realpathSync } from "node:fs";
import { isWithin, normalizeCase, toPosix } from "./path-util.ts";

export type ResolvedPath =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Restricts file access to a set of workspace folders.
 *
 * Paths are resolved against the workspace by name: a relative path must
 * start with the name of one of the workspace folders (e.g. `Aaa/README.md`
 * for a workspace containing the folder `Aaa`), and an absolute path must
 * fall inside one of them. Nothing else is accepted — there is no working
 * directory fallback.
 *
 * Resolved paths are normalized syntactically, then resolved through
 * symlinks (via realpath on existing ancestors) so that symlink escapes are
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
  /**
   * Resolved, absolute workspace roots, sorted by normalized path so that
   * every behavior (folder-name matching, containment checks, the order in
   * which grep/glob walk the folders) is independent of registration order.
   */
  readonly roots: string[];

  constructor(folders: string[]) {
    this.roots = folders
      .map((f) => {
        const abs = isAbsolute(f)
          ? normalize(f)
          : normalize(join(Deno.cwd(), f));
        try {
          // Resolve 8.3 short names and symlinks on the root itself.
          return realpathSync(abs);
        } catch {
          return abs;
        }
      })
      .sort((a, b) => {
        const pa = normalizeCase(toPosix(a));
        const pb = normalizeCase(toPosix(b));
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
  }

  /** Resolve a user/model-supplied path against the sandbox. */
  async resolve(requested: string): Promise<ResolvedPath> {
    if (typeof requested !== "string" || requested.length === 0) {
      return { ok: false, reason: "Path must be a non-empty string" };
    }
    const abs = isAbsolute(requested)
      ? normalize(requested)
      : this.relativeToRoot(requested);
    if (!isAbsolute(abs)) return { ok: false, reason: abs };

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

  /**
   * Map a relative path whose first segment names a workspace folder (e.g.
   * `Aaa/README.md`) to an absolute path. Returns the error message when
   * the first segment is unknown or matches more than one folder.
   */
  private relativeToRoot(requested: string): string {
    const normalized = normalize(requested);
    const slash = normalized.indexOf(sep);
    const first = slash === -1 ? normalized : normalized.slice(0, slash);
    const rest = slash === -1 ? "" : normalized.slice(slash + 1);

    const wanted = normalizeCase(first);
    let match: string | undefined;
    for (const root of this.roots) {
      if (normalizeCase(basename(root)) === wanted) {
        if (match !== undefined) {
          return `Ambiguous workspace folder: ${first} matches more than one folder`;
        }
        match = root;
      }
    }
    if (match === undefined) {
      const known = this.roots.map((r) => basename(r)).join(", ");
      return `Unknown workspace folder: ${first}. Workspace folders: ${known}`;
    }
    return join(match, rest);
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
