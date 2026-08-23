import type { Workspace } from "../types/workspace.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import {
  createEditFileTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
} from "./filesystem.ts";
import { createBashTool } from "./bash.ts";
import { createAsyncBashTools } from "./background.ts";
import type { BackgroundProcessManager } from "./background.ts";
import { createGlobTool, createGrepTool } from "./search.ts";
import { createEvalTool } from "./eval.ts";
import type { Tool } from "./schema.ts";
import { loadProjectMemory } from "../memory/agents-md.ts";
import {
  buildEnvironmentSection,
  type EnvironmentModel,
} from "../environment.ts";
import {
  discoverSkills,
  formatAvailableSkills,
  type SkillDef,
} from "../skills/discover.ts";
import { createSkillTool } from "../skills/tool.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import { type AskHub, createAskTool } from "./ask.ts";
import { createTodoTool, type TodoHub } from "./todo.ts";
import type { TaskHub } from "./task.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import type { BrowserBackend } from "../browser/types.ts";
import { createBrowserTools } from "../browser/tools.ts";

/** Personalization budget (same cap as project memory). */
const MAX_PERSONALIZATION_BYTES = 32 * 1024;

/** Skills for a session, in precedence order: workspace `.agents/skills`,
 * then agent plugin skills (`skills/` of `.agents/plugins` plugins), then
 * global `~/.agents/skills`. Shared with the sub-agent tool builders
 * (tools/task.ts) so both agent kinds see the same skill set. */
export function sessionSkills(folders: string[]): SkillDef[] {
  const plugins = discoverPlugins(folders);
  return discoverSkills(folders, {
    pluginSkills: plugins.flatMap((p) => p.skills),
  });
}

/** The sandboxed file+search tool set: read, write, edit, list_dir, grep,
 * glob. The core of every coding tool set (main agent and general
 * sub-agents share it, so new tools cannot drift between the two). */
export function sandboxFileTools(sandbox: Sandbox): Tool[] {
  return [
    createReadFileTool({ sandbox }),
    createWriteFileTool({ sandbox }),
    createEditFileTool({ sandbox }),
    createListDirTool({ sandbox }),
    createGrepTool({ sandbox }),
    createGlobTool({ sandbox }),
  ];
}

/** The read-only investigation tool set: read, list_dir, grep, glob.
 * Backs the `explore` sub-agent (which must never modify files). */
export function readOnlyInvestigationTools(sandbox: Sandbox): Tool[] {
  return [
    createReadFileTool({ sandbox }),
    createListDirTool({ sandbox }),
    createGrepTool({ sandbox }),
    createGlobTool({ sandbox }),
  ];
}

export interface ToolFactoryOptions {
  /** Extra environment variables for bash commands. */
  env?: Record<string, string>;
  /** Background-command manager backing the async_bash tools. Owned by the
   * caller (the session pool) so the session agent can subscribe to its
   * completion events too; omitted → the async_bash tools are not built. */
  background?: BackgroundProcessManager;
  /** Question hub backing the ask tool (asks the user in the UI and waits
   * for the answer). Omitted → the ask tool is not built. */
  ask?: AskHub;
  /** Todo hub backing the todo tool (per-session plan state, emitted to
   * clients as `todo` events). Omitted → the todo tool is not built. */
  todo?: TodoHub;
  /** Sub-agent hub backing the task / task_output / send_message tools
   * (delegation and agent-to-agent messaging). Omitted → the tools are not
   * built. */
  task?: TaskHub;
  /** Command safety check (the fast model judges bash / eval / async_bash
   * commands before they run). Omitted → the command tools run unchecked. */
  safety?: CommandSafety;
  /** Browser lab backend (Desktop WebView / CLI browser host). Omitted →
   * no browser tools at all — the agent gets no browser surface. */
  browser?: BrowserBackend;
}

/** Build the standard coding tool set, sandboxed to a workspace. */
export function createCodingTools(
  workspace: Workspace,
  options: Partial<ToolFactoryOptions> = {},
): Tool[] {
  const sandbox = new Sandbox(workspace.folders);

  return [
    ...sandboxFileTools(sandbox),
    createBashTool({ sandbox, env: options.env, safety: options.safety }),
    ...(options.background !== undefined
      ? createAsyncBashTools({
        manager: options.background,
        sandbox,
        safety: options.safety,
      })
      : []),
    createEvalTool({ safety: options.safety }),
    createSkillTool({ skills: sessionSkills(workspace.folders) }),
    ...(options.browser !== undefined
      ? createBrowserTools(options.browser)
      : []),
    ...(options.ask !== undefined ? [createAskTool(options.ask)] : []),
    ...(options.todo !== undefined ? [createTodoTool(options.todo)] : []),
    ...(options.task !== undefined ? options.task.parentTools() : []),
  ];
}

/** System prompt describing the agent and its workspace boundaries.
 * `personalInstructions` (the machine-level AGENTS.md next to the settings
 * file) is appended at the very end, after project memory. `model` (the
 * session's model, when known) appears in the environment section between
 * the workspace folders and the guidelines. `headless` swaps the
 * ask-the-user guideline for the headless variant (asks are auto-answered
 * with the recommended/first option, so the model should prefer making a
 * reasonable assumption). */
export function buildSystemPrompt(
  workspace: Workspace,
  personalInstructions?: string,
  model?: EnvironmentModel,
  headless = false,
): string {
  const folders = workspace.folders.map((f) => `- ${f}`).join("\n");
  const memory = loadProjectMemory(workspace.folders);
  const memorySection = memory
    ? `\n\n# Project memory (AGENTS.md)\n${memory}`
    : "";
  const skills = sessionSkills(workspace.folders);
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
${folders}${buildEnvironmentSection(model)}

Guidelines:
- Paths are either absolute or relative to the workspace. A relative path must
  start with the name of a workspace folder above, e.g. \`Aaa/README.md\`.
- Long-running commands (dev servers, watchers, downloads) should be started
  with async_bash instead of bash: it returns immediately and the command
  keeps running after the run ends. Check progress with async_bash_status,
  stop a command with async_bash_kill.
- A user message starting with "[Background command ...]" is a system
  notification about a background command, not a message from the user:
  acknowledge it, but do not mistake it for user input.
- Delegate independent work to sub-agents with the task tool: it starts the
  agent in the background and returns immediately, so keep working while it
  runs. The result arrives as a "[Task ...]" notification, or fetch it with
  task_output (wait: true) when your next step depends on it. Reach a
  running sub-agent with send_message.
- A user message starting with "[Task ...]" or "[Message from ...]" is a
  system notification from a sub-agent or another agent, not a message from
  the user: acknowledge it, but do not mistake it for user input.
- Use the dedicated tools: read to read files, edit to edit them, grep to
  search, glob to explore structure.
- Use eval for quick calculations and data processing instead of spawning
  python or node from bash.
- Plan multi-step work with the todo tool (phases and tasks) and keep it
  up to date as you go; completing the current task advances automatically.
  The user watches your progress live in the UI.
- After making changes, verify them (run tests, builds) when appropriate.
- Ask the user when a task is ambiguous.${
    headless
      ? " (Headless: the ask tool is auto-answered with the " +
        "recommended/first option — prefer making the best reasonable " +
        "assumption and stating it.)"
      : ""
  }
- Prioritize correctness above all else.
- Write code with future maintainers in mind.
- Avoid unnecessary allocations and computation.
- Never discard changes the user has already made.
- For multi-file changes, plan before editing, investigate existing patterns
  before implementing, and fix root causes rather than symptoms. Do a clean
  cutover: leave no old callers or compatibility shims behind.
- Do not stop halfway: carry the work through until the deliverable is
  complete.
- Never fabricate tool or test results.
- Do not silently narrow the requested scope.
- Do not hand in TODOs or placeholder implementations as finished work.
- Do not ask the user for information you can obtain from your tools.
${memorySection}${skillsSection}${personalSection}
`;
}
