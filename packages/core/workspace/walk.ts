import { join, relative } from "node:path";
import type { GitignoreMatcher } from "../tools/gitignore.ts";

/** One visited entry of a walk. `rel` is the path relative to the walk
 * root (posix separators). */
export interface WalkEntry {
  path: string;
  rel: string;
  isDir: boolean;
  depth: number;
}

export interface WalkOptions {
  /** Skip `.`-prefixed entries (default true). */
  skipHidden?: boolean;
  /** Directory names always pruned at any depth (e.g. node_modules). */
  excludedDirs?: ReadonlySet<string>;
  /** Ignored directories are pruned and ignored files are skipped (a
   * matcher loaded from the workspace roots). */
  gitignore?: GitignoreMatcher;
  /** Maximum recursion depth (default 32; the root is depth 0). */
  maxDepth?: number;
  /** Stop after this many emitted entries. */
  maxEntries?: number;
  /** Emit each directory's files before its subdirectory entries (and
   * recurse afterwards), so an entry cap can never be consumed by one
   * alphabetical subtree before its later siblings are seen. */
  filesFirst?: boolean;
}

/**
 * Recursively visit the entries under `root`. Symlinks are never followed;
 * hidden entries and `excludedDirs` are skipped; `gitignore` prunes ignored
 * directories and drops ignored files. With `filesFirst` a directory's
 * files are emitted before its subdirectory entries (then each subtree);
 * otherwise entries stream in depth-first sorted order. Shared by the
 * grep/glob tools and the workspace file listing so the walk policy lives
 * once.
 */
export async function* walkEntries(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkEntry> {
  const skipHidden = options.skipHidden ?? true;
  const maxDepth = options.maxDepth ?? 32;
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  let emitted = 0;

  /** Build the entry for `full` (applying the gitignore filter); undefined
   * when the entry is ignored. */
  const entryFor = (dir: string, name: string): WalkEntry | undefined => {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (options.gitignore?.ignores(root, rel, false)) return undefined;
    return { path: full, rel, isDir: false, depth: 0 };
  };

  async function* walk(dir: string, depth: number): AsyncGenerator<WalkEntry> {
    if (depth > maxDepth || emitted >= maxEntries) return;
    let list: Deno.DirEntry[];
    try {
      list = [...Deno.readDirSync(dir)];
    } catch {
      return; // unreadable directory (permissions, race) — skip
    }
    list.sort((a, b) => a.name.localeCompare(b.name));

    const filtered = list.filter((entry) => {
      if (entry.isSymlink) return false; // never follow symlinks
      if (skipHidden && entry.name.startsWith(".")) return false;
      if (entry.isDirectory && options.excludedDirs?.has(entry.name)) {
        return false;
      }
      return true;
    });

    if (options.filesFirst === true) {
      // Files first: emit the directory's files, then each subdirectory
      // entry, then recurse into it.
      const subdirs: Deno.DirEntry[] = [];
      for (const entry of filtered) {
        if (entry.isDirectory) {
          subdirs.push(entry);
          continue;
        }
        if (!entry.isFile) continue;
        const item = entryFor(dir, entry.name);
        if (item === undefined) continue;
        if (emitted >= maxEntries) return;
        emitted++;
        yield item;
      }
      for (const entry of subdirs) {
        if (emitted >= maxEntries) return;
        const full = join(dir, entry.name);
        const rel = relative(root, full);
        if (options.gitignore?.ignores(root, rel, true)) continue;
        emitted++;
        yield { path: full, rel, isDir: true, depth };
        yield* walk(full, depth + 1);
      }
      return;
    }

    // Depth-first in sorted order: directories recurse immediately, files
    // yield as encountered.
    for (const entry of filtered) {
      if (emitted >= maxEntries) return;
      if (entry.isDirectory) {
        const full = join(dir, entry.name);
        const rel = relative(root, full);
        // An ignored directory means everything below it is ignored too.
        if (options.gitignore?.ignores(root, rel, true)) continue;
        yield* walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile) continue;
      const item = entryFor(dir, entry.name);
      if (item === undefined) continue;
      emitted++;
      yield item;
    }
  }

  yield* walk(root, 0);
}
