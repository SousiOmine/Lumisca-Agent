import { isAbsolute, join, normalize, sep } from "node:path";
import { findRepoRoot } from "../memory/agents-md.ts";
import { parseSkillFrontmatter } from "./frontmatter.ts";

/** Directory holding skills inside a repository level or in the home
 * directory. Only the `.agents` convention is supported. */
export const AGENTS_SKILLS_DIR = ".agents/skills";

/** Cap for the `<available_skills>` listing in the system prompt. */
export const MAX_AVAILABLE_SKILLS_BYTES = 16 * 1024;

/** Cap for a single skill file (SKILL.md or a follow-up read). */
export const MAX_SKILL_FILE_BYTES = 64 * 1024;

export type SkillSource = "workspace" | "global";

export interface SkillDef {
  name: string;
  description: string;
  /** Absolute path of the SKILL.md file. */
  path: string;
  /** Absolute path of the skill directory (parent of SKILL.md). */
  dir: string;
  source: SkillSource;
}

export interface DiscoverOptions {
  /** Global skills directories to scan instead of ~/.agents/skills.
   * Used by tests to avoid touching the real home directory. */
  globalDirs?: string[];
}

/** Discover skills for a set of workspace folders. For each folder the
 * repository root is located (via `.git`), then every `.agents/skills`
 * directory from the root down to the folder is scanned (root first, like
 * project memory). Global skills (~/.agents/skills) are appended after, so
 * a workspace skill always shadows a global one of the same name. */
export function discoverSkills(
  folders: string[],
  options: DiscoverOptions = {},
): SkillDef[] {
  const byName = new Map<string, SkillDef>();
  const seenPaths = new Set<string>();

  for (const folder of folders) {
    const root = findRepoRoot(folder);
    // Walk from the folder up to the root, then reverse so root-first.
    const chain: string[] = [folder];
    let current = folder;
    while (current !== root) {
      const parent = join(current, "..");
      if (parent === current) break;
      chain.push(parent);
      current = parent;
    }
    chain.reverse();
    for (const dir of chain) {
      scanSkillsDir(
        join(dir, AGENTS_SKILLS_DIR),
        "workspace",
        byName,
        seenPaths,
      );
    }
  }
  for (const dir of resolveGlobalDirs(options.globalDirs)) {
    scanSkillsDir(dir, "global", byName, seenPaths);
  }
  return [...byName.values()];
}

/** The `<available_skills>` listing for the system prompt: one
 * `- name: description` line per skill, capped at MAX_AVAILABLE_SKILLS_BYTES
 * (skills past the cap stay loadable via the skill tool by name). */
export function formatAvailableSkills(skills: SkillDef[]): string {
  let out = "";
  for (const skill of skills) {
    const line = `- ${skill.name}: ${skill.description}`;
    const candidate = out === "" ? line : `${out}\n${line}`;
    if (candidate.length > MAX_AVAILABLE_SKILLS_BYTES) break;
    out = candidate;
  }
  return out;
}

/** Read a skill file: SKILL.md by default, or a file inside the skill
 * directory when `relativePath` is given (the skill tool's follow-up read).
 * Paths that escape the skill directory are rejected; reads are capped at
 * MAX_SKILL_FILE_BYTES. */
export function loadSkillContent(
  skill: SkillDef,
  relativePath?: string,
): string {
  const path = relativePath === undefined
    ? skill.path
    : resolveInside(skill.dir, relativePath);
  const text = readIfExists(path);
  if (text === undefined) {
    throw new Error(
      `No such file in skill "${skill.name}": ${relativePath}`,
    );
  }
  return text.length > MAX_SKILL_FILE_BYTES
    ? `${
      text.slice(0, MAX_SKILL_FILE_BYTES)
    }\n\n… (file truncated at ${MAX_SKILL_FILE_BYTES} bytes)`
    : text;
}

function scanSkillsDir(
  dir: string,
  source: SkillSource,
  byName: Map<string, SkillDef>,
  seenPaths: Set<string>,
): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return; // no skills directory at this level
  }
  // Sort for deterministic precedence when several skills share a name.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const skillDir = join(dir, entry.name);
    const skillPath = join(skillDir, "SKILL.md");
    if (seenPaths.has(skillPath)) continue;
    seenPaths.add(skillPath);
    const text = readIfExists(skillPath);
    if (text === undefined) continue;
    const meta = parseSkillFrontmatter(text);
    if (meta === undefined) continue;
    // The frontmatter name must match the directory name (OpenCode rule);
    // anything else is not a loadable skill.
    if (meta.name !== entry.name) continue;
    if (byName.has(meta.name)) continue;
    byName.set(meta.name, {
      name: meta.name,
      description: meta.description,
      path: skillPath,
      dir: skillDir,
      source,
    });
  }
}

function resolveGlobalDirs(injected?: string[]): string[] {
  if (injected !== undefined) return injected;
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME");
  if (home === undefined || home === "") return [];
  return [join(home, AGENTS_SKILLS_DIR)];
}

function resolveInside(dir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(
      `Path is not relative to the skill directory: ${relativePath}`,
    );
  }
  const resolved = normalize(join(dir, relativePath));
  const root = normalize(dir);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path escapes the skill directory: ${relativePath}`);
  }
  return resolved;
}

function readIfExists(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return undefined;
  }
}
