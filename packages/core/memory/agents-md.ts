import { join } from "node:path";
import { readIfExists } from "../fs.ts";

/** Combined project memory budget (matches Codex's project_doc_max_bytes). */
export const MAX_MEMORY_BYTES = 32 * 1024;

/** How many levels to walk up when looking for the repository root. */
const MAX_REPO_LEVELS = 10;

/** Find the repository root by walking up from `folder` until a `.git`
 * entry (directory or file) is found. Falls back to `folder` itself. */
export function findRepoRoot(folder: string): string {
  let current = folder;
  for (let i = 0; i < MAX_REPO_LEVELS; i++) {
    try {
      Deno.statSync(join(current, ".git"));
      return current;
    } catch {
      // no .git here — keep walking up
    }
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return folder;
}

/** The directory chain from `folder` up to (and including) the repository
 * root, ordered root-first. Shared by project memory, skills and plugin
 * discovery so every `.git`-based walk follows the same rule. */
export function repoChain(folder: string): string[] {
  const root = findRepoRoot(folder);
  const chain: string[] = [folder];
  let current = folder;
  while (current !== root) {
    const parent = join(current, "..");
    if (parent === current) break;
    chain.push(parent);
    current = parent;
  }
  chain.reverse();
  return chain;
}

/** One instruction file as loaded from disk. */
export interface MemoryFile {
  /** Absolute path of the instruction file. */
  path: string;
  content: string;
}

/** The model-facing heading of one instruction file, used both to render a
 * workspace instruction baseline and to budget it. */
export function instructionHeading(path: string): string {
  return `Instructions from: ${path}`;
}

/**
 * Load the workspace instruction files (AGENTS.md / AGENTS.override.md) for
 * a set of workspace folders, root-first. For each folder the repository
 * root is located (via `.git`), then every AGENTS.md from the root down to
 * the folder is read; an AGENTS.override.md in a directory replaces the
 * AGENTS.md beside it. The list is capped so the rendered instruction block
 * stays within MAX_MEMORY_BYTES: the file that crosses the cap is truncated
 * and ends the list.
 */
export function loadProjectMemoryFiles(folders: string[]): MemoryFile[] {
  const seen = new Set<string>();
  const files: MemoryFile[] = [];
  let budget = MAX_MEMORY_BYTES;

  for (const folder of folders) {
    for (const dir of repoChain(folder)) {
      const override = readIfExists(join(dir, "AGENTS.override.md"));
      const content = override ?? readIfExists(join(dir, "AGENTS.md"));
      if (content === undefined) continue;
      const path = join(
        dir,
        override !== undefined ? "AGENTS.override.md" : "AGENTS.md",
      );
      if (seen.has(path)) continue;
      seen.add(path);

      // Headings and separators count against the cap so the rendered
      // block never exceeds it, however many files are merged.
      const overhead = instructionHeading(path).length + 4;
      const room = budget - overhead;
      if (room <= 0) return files;
      if (content.length > room) {
        files.push({ path, content: content.slice(0, room) });
        return files;
      }
      files.push({ path, content });
      budget -= overhead + content.length;
    }
  }
  return files;
}
