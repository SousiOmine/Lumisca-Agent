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
import { loadSkillContent, type SkillDef } from "./discover.ts";
import { MAX_SKILL_FILE_BYTES } from "./discover.ts";

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
 * skill directory) is read when the agent actually uses the skill. */
export function createSkillTool(
  ctx: { skills: SkillDef[] },
): Tool<typeof skillSchema> {
  const byName = new Map(ctx.skills.map((s) => [s.name, s]));
  const names = ctx.skills.map((s) => s.name);
  const known = names.length === 0 ? "(none)" : names.join(", ");
  return {
    name: TOOL_SKILL,
    label: "Skill",
    description:
      "Load one skill: its SKILL.md instructions plus, optionally, one " +
      "file from the skill directory (`read_followup`). The result is the " +
      "file's text, truncated with a `… (file truncated at N bytes)` note " +
      `when it exceeds ${MAX_SKILL_FILE_BYTES} bytes. An unknown name ` +
      `fails with \`Unknown skill "<name>"\` followed by the skill names ` +
      "that exist. The session skill catalog lists every available skill " +
      "with its description.",
    parameters: skillSchema,
    execute: (_id, params): Promise<ToolResult> => {
      const skill = byName.get(params.name);
      if (skill === undefined) {
        throw new Error(
          `Unknown skill "${params.name}". Available skills: ${known}`,
        );
      }
      const text = loadSkillContent(skill, params.read_followup);
      return Promise.resolve({
        content: [{ type: "text", text }],
        details: {
          name: skill.name,
          // File-based skills report where they were read from;
          // app-embedded (built-in) skills have no path.
          ...(skill.path !== undefined ? { path: skill.path } : {}),
          ...(skill.dir !== undefined ? { dir: skill.dir } : {}),
        },
      });
    },
  };
}
