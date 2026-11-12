import { TOOL_SKILL } from "../shared/mod.ts";
import {
  object,
  optional,
  type SchemaObject,
  type SchemaOptional,
  type SchemaString,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import {
  loadSkillContent,
  MAX_SKILL_FILE_BYTES,
  type SkillDef,
} from "./discover.ts";

const skillSchema: SchemaObject<{
  name: SchemaString;
  read_followup: SchemaOptional<SchemaString>;
}> = object({
  name: string(
    "Exact skill name from the session skill catalog (the " +
      "<available_skills> listing published as a skill catalog message).",
  ),
  read_followup: optional(
    string(
      "File path relative to the skill's directory whose content should be read after SKILL.md (e.g. a referenced reference.md). Omit to read only SKILL.md.",
    ),
  ),
});

/** Load a skill's instructions on demand. The session skill catalog lists
 * name + description; the full SKILL.md (and optionally one file from the
 * skill directory) is read when the agent actually uses the skill.
 *
 * The set is a getter, not a fixed array: a session can gain a skill while
 * it runs (the agent writes one into its workspace or the shared folder —
 * see the skill-authoring guide), and the catalog provider publishes that
 * change on the next turn. A snapshot would leave the two disagreeing: the
 * model would read a name in the catalog and get "unknown skill" from the
 * tool. Resolving per call costs one directory scan (the same discovery the
 * catalog runs) and is what keeps the list and the tool the same set. */
export function createSkillTool(ctx: {
  skills: () => SkillDef[];
}): Tool<typeof skillSchema> {
  return {
    name: TOOL_SKILL,
    label: "Skill",
    description:
      "Load one skill: its SKILL.md instructions plus, optionally, one " +
      "file from the skill directory (`read_followup`). The result is the " +
      "file's text, truncated with a " +
      "`[file truncated to the first N bytes]` note when it exceeds " +
      `${MAX_SKILL_FILE_BYTES} bytes. An unknown name ` +
      `fails with \`Unknown skill "<name>"\` followed by the skill names ` +
      "that exist. The session skill catalog lists every available skill; " +
      "a skill's description says when to load it, so load one before " +
      "starting work that its description covers.",
    parameters: skillSchema,
    execute: async (_id, params): Promise<ToolResult> => {
      const skills = ctx.skills();
      const skill = skills.find((candidate) => candidate.name === params.name);
      if (skill === undefined) {
        const known =
          skills.length === 0
            ? "(none)"
            : skills.map((candidate) => candidate.name).join(", ");
        throw new Error(
          `Unknown skill "${params.name}". Available skills: ${known}`,
        );
      }
      const text = await loadSkillContent(skill, params.read_followup);
      return {
        content: [{ type: "text", text }],
        details: {
          name: skill.name,
          // File-based skills report where they were read from;
          // app-embedded (built-in) skills have no path.
          ...(skill.path !== undefined ? { path: skill.path } : {}),
          ...(skill.dir !== undefined ? { dir: skill.dir } : {}),
        },
      };
    },
  };
}
