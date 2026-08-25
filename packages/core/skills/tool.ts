import { TOOL_SKILL } from "../shared.ts";
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

const skillSchema: SchemaObject<{
  name: SchemaString;
  read_followup: SchemaOptional<SchemaString>;
}> = object({
  name: string(
    "Name of the skill to load, from the <available_skills> listing in the system prompt (or the list in this tool's description).",
  ),
  read_followup: optional(
    string(
      "File path relative to the skill's directory whose content should be read after SKILL.md (e.g. a referenced reference.md). Omit to read only SKILL.md.",
    ),
  ),
});

/** Cap on skill names embedded in the tool description so the description
 * stays small even with many skills installed. */
const MAX_DESCRIBED_SKILLS = 20;

/** Load a skill's instructions on demand. The system prompt only lists
 * name + description; the full SKILL.md (and optionally one file from the
 * skill directory) is read when the agent actually uses the skill. */
export function createSkillTool(
  ctx: { skills: SkillDef[] },
): Tool<typeof skillSchema> {
  const byName = new Map(ctx.skills.map((s) => [s.name, s]));
  const names = ctx.skills.map((s) => s.name);
  const listed = names.length <= MAX_DESCRIBED_SKILLS
    ? names.join(", ")
    : `${names.slice(0, MAX_DESCRIBED_SKILLS).join(", ")} … and ${
      names.length - MAX_DESCRIBED_SKILLS
    } more`;
  return {
    name: TOOL_SKILL,
    label: "Skill",
    description:
      `Load a reusable skill: its SKILL.md instructions plus, optionally, one file ` +
      `from the skill directory (read_followup). Call this when a task matches an ` +
      `available skill. Available skills: ${listed || "(none)"}`,
    parameters: skillSchema,
    execute: (_id, params): Promise<ToolResult> => {
      const skill = byName.get(params.name);
      if (skill === undefined) {
        throw new Error(
          `Unknown skill "${params.name}". Available skills: ${
            listed || "(none)"
          }`,
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
