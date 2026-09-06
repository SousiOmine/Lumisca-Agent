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
import { createSkillTool } from "../skills/tool.ts";
import { builtinSkills } from "../skills/builtin/mod.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import { discoverSkills, type SkillDef } from "../skills/discover.ts";
import { type AskHub, createAskTool } from "./ask.ts";
import { createTodoTool, type TodoHub } from "./todo.ts";
import type { TaskHub } from "./task-hub.ts";
import type { CommandSafety } from "../safety/command-safety.ts";

/** Skills for a session, in precedence order: workspace `.agents/skills`,
 * then agent plugin skills (`skills/` of `.agents/plugins` plugins), then
 * global `~/.agents/skills`, then app-embedded built-in skills — any user
 * skill shadows a same-named built-in one. Shared with the sub-agent tool
 * builders (tools/task.ts) so both agent kinds see the same skill set.
 *
 * `browserAvailable` gates the built-in web-browser skill: it is only
 * advertised when a browser backend is attached to the session, so a
 * session that can never run browser tools does not point the agent at
 * them. Undefined → the browser skill is not advertised (callers that
 * know the backend state must say so). */
export function sessionSkills(
  folders: string[],
  options: { browserAvailable?: boolean } = {},
): SkillDef[] {
  const plugins = discoverPlugins(folders);
  return discoverSkills(folders, {
    pluginSkills: plugins.flatMap((p) => p.skills),
    builtinSkills: builtinSkills({
      browser: options.browserAvailable === true,
    }),
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
  /** Whether the session has a browser backend attached (the browser-lab
   * tools are seeded into the session's tool registry). Gates the
   * built-in web-browser skill: it is only advertised when true.
   * Omitted/undefined → the skill is not advertised. */
  browserAvailable?: boolean;
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
    createSkillTool({
      skills: sessionSkills(workspace.folders, {
        browserAvailable: options.browserAvailable,
      }),
    }),
    ...(options.ask !== undefined ? [createAskTool(options.ask)] : []),
    ...(options.todo !== undefined ? [createTodoTool(options.todo)] : []),
    ...(options.task !== undefined ? options.task.parentTools() : []),
  ];
}

/** Build the tool set of a chat session ("simple chat" without a
 * workspace): no sandbox, no shell — file, bash, async_bash, eval and
 * sub-agent tools are all absent. Ask (clarifying questions), todo (a
 * lightweight plan) and global skills stay useful outside a workspace, and
 * discoverable tools — MCP and browser-lab alike — attach via the session's
 * tool registry as usual (sidebar: the tool_search / tool_call pair is
 * added by the session agent itself, not here). */
export function createChatTools(
  options: Partial<ToolFactoryOptions> = {},
): Tool[] {
  return [
    // Only global skills apply (no workspace folders to discover from).
    createSkillTool({
      skills: sessionSkills([], {
        browserAvailable: options.browserAvailable,
      }),
    }),
    ...(options.ask !== undefined ? [createAskTool(options.ask)] : []),
    ...(options.todo !== undefined ? [createTodoTool(options.todo)] : []),
  ];
}
