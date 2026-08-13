import { basename } from "node:path";
import type { Workspace } from "../types/workspace.ts";
import { walkEntries } from "./walk.ts";

/** One entry in a workspace file listing, for @-mention suggestions.
 * `path` is workspace-relative in the `FolderName/rel/path` form the
 * coding tools accept (posix separators, so it is portable in chat text). */
export interface WorkspaceFileEntry {
  path: string;
  /** Basename of the entry (the last path segment). */
  name: string;
  isDir: boolean;
}

/** Directories skipped while walking (on top of hidden `.`-prefixed ones),
 * matching the grep/glob tools' behavior plus common build caches (web,
 * Rust, .NET). Without these, a single build-output tree can consume the
 * whole entry budget before deeper siblings are reached. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".lumisca-cache",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "target",
  "bin",
  "obj",
]);

const MAX_DEPTH = 12;

/**
 * Recursively list the files and folders inside a workspace, each with the
 * workspace-relative path (`FolderName/rel/path`). Hidden entries and
 * EXCLUDED_DIRS are skipped; symlinks are never followed; the walk stops at
 * MAX_DEPTH and `max` entries. Within a directory, files are emitted before
 * subdirectories, so the entry cap can never be consumed by one alphabetical
 * subtree before its later siblings are seen (see walkEntries).
 */
export async function listWorkspaceFiles(
  workspace: Workspace,
  max = 5000,
): Promise<WorkspaceFileEntry[]> {
  const entries: WorkspaceFileEntry[] = [];

  for (const folder of workspace.folders) {
    const stat = await Deno.stat(folder).catch(() => null);
    if (!stat || !stat.isDirectory) continue;
    const folderName = basename(folder);
    entries.push({ path: folderName, name: folderName, isDir: true });
    for await (
      const item of walkEntries(folder, {
        skipHidden: true,
        excludedDirs: EXCLUDED_DIRS,
        maxDepth: MAX_DEPTH,
        maxEntries: max,
        filesFirst: true,
      })
    ) {
      if (entries.length >= max) break;
      const rel = item.rel.replace(/\\/g, "/");
      entries.push({
        path: `${folderName}/${rel}`,
        name: rel.slice(rel.lastIndexOf("/") + 1),
        isDir: item.isDir,
      });
    }
    if (entries.length >= max) break;
  }
  return entries;
}

/**
 * Filter and rank a file listing for @-mention suggestions. Matches are
 * case-insensitive against the basename or the full path; basename
 * prefix hits rank first, then basename contains, then path contains.
 * `limit` caps the result.
 */
export function suggestWorkspaceFiles(
  entries: WorkspaceFileEntry[],
  query: string,
  limit = 200,
): WorkspaceFileEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return entries.slice(0, limit);

  const ranked: Array<{ entry: WorkspaceFileEntry; score: number }> = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const path = entry.path.toLowerCase();
    const nameIdx = name.indexOf(q);
    const pathIdx = path.indexOf(q);
    if (nameIdx === -1 && pathIdx === -1) continue;
    const score = nameIdx === 0 ? 0 : nameIdx > 0 ? 1 : 2;
    ranked.push({ entry, score });
  }
  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return ranked.slice(0, limit).map((r) => r.entry);
}
