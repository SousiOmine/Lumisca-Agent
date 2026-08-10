import type { Workspace } from "../types/workspace.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import {
  createEditFileTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
} from "./filesystem.ts";
import { createBashTool } from "./bash.ts";
import { createGlobTool, createGrepTool } from "./search.ts";
import type { Tool } from "./schema.ts";
import { loadProjectMemory } from "../memory/agents-md.ts";
import { discoverSkills, formatAvailableSkills } from "../skills/discover.ts";
import { createSkillTool } from "../skills/tool.ts";

/** Personalization budget (same cap as project memory). */
const MAX_PERSONALIZATION_BYTES = 32 * 1024;

export interface ToolFactoryOptions {
  /** Extra environment variables for bash commands. */
  env?: Record<string, string>;
}

/** Build the standard coding tool set, sandboxed to a workspace. */
export function createCodingTools(
  workspace: Workspace,
  options: Partial<ToolFactoryOptions> = {},
): Tool[] {
  const sandbox = new Sandbox(workspace.folders);
  const ctx = { sandbox };

  return [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createEditFileTool(ctx),
    createListDirTool(ctx),
    createGrepTool(ctx),
    createGlobTool(ctx),
    createBashTool({ sandbox, env: options.env }),
    createSkillTool({ skills: discoverSkills(workspace.folders) }),
  ];
}

/** System prompt describing the agent and its workspace boundaries.
 * `personalInstructions` (the machine-level AGENTS.md next to the settings
 * file) is appended at the very end, after project memory. */
export function buildSystemPrompt(
  workspace: Workspace,
  personalInstructions?: string,
): string {
  const folders = workspace.folders.map((f) => `- ${f}`).join("\n");
  const memory = loadProjectMemory(workspace.folders);
  const memorySection = memory
    ? `\n\n# Project memory (AGENTS.md)\n${memory}`
    : "";
  const skills = discoverSkills(workspace.folders);
  const skillsSection = skills.length > 0
    ? `\n\n# Skills\nSkills are reusable instructions stored as SKILL.md files. ` +
      `When a task matches one of the skills below, load it with the skill ` +
      `tool — the tool returns the skill's full instructions (and can read ` +
      `additional files from the skill directory via read_followup).\n` +
      `<available_skills>\n${
        formatAvailableSkills(skills)
      }\n</available_skills>`
    : "";
  const personal = (personalInstructions ?? "").trim();
  const personalSection = personal
    ? `\n\n# Personal instructions (AGENTS.md)\n${
      personal.length > MAX_PERSONALIZATION_BYTES
        ? personal.slice(0, MAX_PERSONALIZATION_BYTES)
        : personal
    }`
    : "";
  return `You are Lumisca, a coding agent that works inside a workspace.

The workspace contains these folders (file access is restricted to them):
${folders}

Guidelines:
- Read files before editing them.
- Paths are either absolute or relative to the workspace. A relative path must
  start with the name of a workspace folder above, e.g. \`Aaa/README.md\`.
- The bash tool requires a \`cwd\` argument: a workspace folder name (e.g.
  \`Aaa\`) or an absolute path.
- After making changes, verify them (run tests, builds) when appropriate.
- Ask the user when a task is ambiguous.
${memorySection}${skillsSection}${personalSection}
`;
}
