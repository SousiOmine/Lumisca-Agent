import { parse } from "@std/yaml";

/** Skill-name rule: lowercase alphanumeric words joined by single hyphens
 * (same rule as OpenCode). Must also match the skill directory name. */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Name length limit (OpenCode: 1–64 characters). */
export const MAX_NAME_LENGTH = 64;

/** Description length limit (OpenCode: 1–1024 characters). */
export const MAX_DESCRIPTION_LENGTH = 1024;

export interface SkillFrontmatter {
  name: string;
  description: string;
}

/** Parse and validate the YAML frontmatter of a SKILL.md. Returns undefined
 * when the file has no frontmatter or the fields are invalid — discovery
 * skips such files entirely (no fallback to a "best effort" name). */
export function parseSkillFrontmatter(
  text: string,
): SkillFrontmatter | undefined {
  // A `---`-delimited YAML block must start the file (CRLF tolerant).
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || typeof description !== "string") {
    return undefined;
  }
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return undefined;
  if (!NAME_PATTERN.test(name)) return undefined;
  if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
    return undefined;
  }
  return { name, description };
}
