/**
 * The stella machine's skill catalog.
 *
 * Two kinds of skills reach a stella session:
 *
 * - **The app's own** — the built-in ones, plus whatever the host user keeps
 *   in `~/.agents/skills`. Reading those from the host is deliberate: they are
 *   the user's standing instructions, not files in the machine, and an agent
 *   that ignored them would not be the same assistant the user configured.
 * - **The machine's** — `<home>/.agents/skills` inside the VM, so a skill the
 *   agent writes while working is one it can also load. This is the only part
 *   that has to cross the boundary, and it does so through the session's exec
 *   seam.
 *
 * Precedence follows the host's rule: a machine skill shadows a global one of
 * the same name, and any user skill shadows a built-in.
 */
import { posix } from "node:path";
import type { SkillDef } from "../skills/discover.ts";
import { discoverSkills, MAX_SKILL_FILE_BYTES } from "../skills/discover.ts";
import { parseSkillFrontmatter } from "../skills/frontmatter.ts";
import type { VmExec } from "./container.ts";
import { VM_SKILLS_DIR } from "./contract.ts";

/** A skill read never takes longer than this. */
const SKILL_READ_TIMEOUT_MS = 30_000;

/**
 * Skills found in the machine's `.agents/skills`, plus the built-ins and
 * host-global skills a session without a workspace would get.
 *
 * Asynchronous because the machine's directory is listed over `podman exec`;
 * the host-global part is the same discovery every chat session uses, so a
 * user's standing skills behave identically in both modes.
 */
export async function discoverVmSkills(options: {
  exec: VmExec;
  /** Built-in skills for this session (browser / computer variants). */
  builtinSkills: SkillDef[];
  /** Global skills directories to scan instead of the real home (tests). */
  globalDirs?: string[];
}): Promise<SkillDef[]> {
  const vmSkills = await scanVmSkillsDir(options.exec, VM_SKILLS_DIR);
  // Host-global skills first (they are the user's standing configuration),
  // then the machine's own, so a machine skill wins a name collision.
  const hostGlobal = discoverSkills([], {
    builtinSkills: options.builtinSkills,
    ...(options.globalDirs !== undefined
      ? { globalDirs: options.globalDirs }
      : {}),
  });
  const byName = new Map<string, SkillDef>();
  for (const skill of hostGlobal) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  for (const skill of vmSkills) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

/**
 * Read the machine's skills directory. Each skill is a directory holding a
 * `SKILL.md` whose frontmatter names it (the same rule the host applies: the
 * name must match the directory, otherwise it is not loadable).
 */
export async function scanVmSkillsDir(
  exec: VmExec,
  dir: string,
): Promise<SkillDef[]> {
  // One call lists the candidate directories and their SKILL.md bodies,
  // separated by a marker line, so a catalog read costs one round trip rather
  // than one per skill.
  const result = await exec(
    [
      "sh",
      "-c",
      'cd "$1" 2>/dev/null || exit 0; ' +
      "for entry in */; do " +
      'name=${entry%/}; [ -f "$name/SKILL.md" ] || continue; ' +
      'printf "\\n__SKILL__%s\\n" "$name"; cat "$name/SKILL.md"; done',
      "sh",
      dir,
    ],
    {
      timeoutMs: SKILL_READ_TIMEOUT_MS,
      maxOutput: 4 * 1024 * 1024,
      keep: "head",
    },
  );
  if (result.exitCode !== 0) return [];

  const skills: SkillDef[] = [];
  const seen = new Set<string>();
  for (const block of result.stdout.split("\n__SKILL__")) {
    const trimmed = block.replace(/^\n/, "");
    const newline = trimmed.indexOf("\n");
    if (newline === -1) continue;
    const dirName = trimmed.slice(0, newline).trim();
    const text = trimmed.slice(newline + 1);
    if (dirName === "" || seen.has(dirName)) continue;
    const meta = parseSkillFrontmatter(text);
    if (meta === undefined) continue;
    // The frontmatter name must match the directory name (the same rule the
    // host applies), and only the first skill of a name wins.
    if (meta.name !== dirName) continue;
    seen.add(dirName);
    const skillDir = posix.join(dir, dirName);
    skills.push({
      name: meta.name,
      description: meta.description,
      path: `${skillDir}/SKILL.md`,
      dir: skillDir,
      source: "workspace",
      read: (relativePath) =>
        readVmSkillFile(exec, skillDir, dirName, relativePath),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Read one file of a machine skill: SKILL.md, or a file inside the skill's
 * directory. A path escaping the directory is refused (the same rule the
 * host's reader enforces), and the read is capped like every other. */
async function readVmSkillFile(
  exec: VmExec,
  skillDir: string,
  name: string,
  relativePath: string | undefined,
): Promise<string> {
  const target = relativePath === undefined
    ? `${skillDir}/SKILL.md`
    : skillTarget(skillDir, name, relativePath);
  const result = await exec(
    ["sh", "-c", 'cat -- "$1" 2>/dev/null || exit 4', "sh", target],
    {
      timeoutMs: SKILL_READ_TIMEOUT_MS,
      maxOutput: MAX_SKILL_FILE_BYTES,
      keep: "head",
    },
  );
  if (result.exitCode === 4) {
    throw new Error(
      relativePath === undefined
        ? `No such file in skill "${name}": SKILL.md`
        : `No such file in skill "${name}": ${relativePath}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not read the skill "${name}": ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/** Resolve a follow-up path inside a skill directory, refusing escapes. */
function skillTarget(
  skillDir: string,
  name: string,
  relativePath: string,
): string {
  if (posix.isAbsolute(relativePath)) {
    throw new Error(
      `Path must be relative to the skill directory: ${relativePath}`,
    );
  }
  const target = posix.normalize(posix.join(skillDir, relativePath));
  const prefix = skillDir.endsWith("/") ? skillDir : `${skillDir}/`;
  if (target !== skillDir && !target.startsWith(prefix)) {
    throw new Error(
      `Path escapes the skill directory of "${name}": ${relativePath}`,
    );
  }
  return target;
}
