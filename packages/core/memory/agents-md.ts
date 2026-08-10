import { join } from "node:path";

/** Combined project memory budget (matches Codex's project_doc_max_bytes). */
const MAX_MEMORY_BYTES = 32 * 1024;

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

function readIfExists(dir: string, name: string): string | undefined {
  const path = join(dir, name);
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Load project memory (AGENTS.md / AGENTS.override.md) for a set of
 * workspace folders. For each folder, the repository root is located (via
 * `.git`), then every AGENTS.md from the root down to the folder is read;
 * an AGENTS.override.md in a directory replaces the AGENTS.md there.
 * Files are concatenated with `# <path>` headers, capped at 32 KB total.
 */
export function loadProjectMemory(folders: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  let budget = MAX_MEMORY_BYTES;

  for (const folder of folders) {
    for (const dir of repoChain(folder)) {
      const override = readIfExists(dir, "AGENTS.override.md");
      const content = override ?? readIfExists(dir, "AGENTS.md");
      if (content === undefined) continue;
      const path = join(
        dir,
        override !== undefined ? "AGENTS.override.md" : "AGENTS.md",
      );
      if (seen.has(path)) continue;
      seen.add(path);

      if (content.length > budget) {
        parts.push(`# ${path}\n\n${content.slice(0, budget)}`);
        budget = 0;
      } else {
        parts.push(`# ${path}\n\n${content}`);
        budget -= content.length;
      }
      if (budget <= 0) break;
    }
    if (budget <= 0) break;
  }

  // Headers and separators also consume budget; clamp so the total never
  // exceeds the cap regardless of how many files were merged.
  const joined = parts.join("\n\n");
  return joined.length <= MAX_MEMORY_BYTES
    ? joined
    : joined.slice(0, MAX_MEMORY_BYTES);
}
