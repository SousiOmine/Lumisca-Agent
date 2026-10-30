import type { Workspace } from "../types/workspace.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { HostFileBackend } from "./host/files.ts";
import { HostCommandRunner } from "./host/command-runner.ts";
import type { FileBackend } from "./file-backend.ts";
import type { CommandRunner } from "./command-backend.ts";
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
import { type ChatAttachTarget, createChatAttachTool } from "./attach.ts";
import { createVisualTool, type VisualTarget } from "./visual.ts";
import { createWebSearchTools } from "./web.ts";
import type { SearchProvider } from "../websearch/types.ts";
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
 * know the backend state must say so). `computerAvailable` gates the
 * built-in computer-use skill the same way: it is only advertised when the
 * machine can actually be driven AND the user enabled the feature.
 * `globalDirs` overrides the global skills directory (~/.agents/skills);
 * tests pass a fixture directory so they never read the developer's own
 * skills. */
export function sessionSkills(
  folders: string[],
  options: {
    browserAvailable?: boolean;
    computerAvailable?: boolean;
    globalDirs?: string[];
  } = {},
): SkillDef[] {
  const plugins = discoverPlugins(folders);
  return discoverSkills(folders, {
    pluginSkills: plugins.flatMap((p) => p.skills),
    builtinSkills: builtinSkills({
      browser: options.browserAvailable === true,
      computer: options.computerAvailable === true,
    }),
    globalDirs: options.globalDirs,
  });
}

/** The sandboxed file+search tool set: read, write, edit, list_dir, grep,
 * glob. The core of every coding tool set (main agent and general
 * sub-agents share it, so new tools cannot drift between the two). */
export function fileTools(files: FileBackend): Tool[] {
  return [
    createReadFileTool({ files }),
    createWriteFileTool({ files }),
    createEditFileTool({ files }),
    createListDirTool({ files }),
    createGrepTool({ files }),
    createGlobTool({ files }),
  ];
}

/** The read-only investigation tool set: read, list_dir, grep, glob.
 * Backs the `explore` sub-agent (which must never modify files). */
export function readOnlyInvestigationTools(files: FileBackend): Tool[] {
  return [
    createReadFileTool({ files }),
    createListDirTool({ files }),
    createGrepTool({ files }),
    createGlobTool({ files }),
  ];
}

/** The tool backend of a workspace on this machine: files under the
 * workspace folders, commands on this host. The single place the host
 * implementations are chosen, so a caller that wants the stella VM's
 * backends has to say so explicitly. */
export function hostBackends(workspace: Workspace): {
  files: FileBackend;
  runner: CommandRunner;
} {
  return {
    files: new HostFileBackend(new Sandbox(workspace.folders)),
    runner: new HostCommandRunner(),
  };
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
  /** Whether the session may drive this machine's screen, mouse and
   * keyboard (a computer host is attached AND the user enabled the
   * feature). Gates the built-in computer-use skill the same way.
   * Omitted/undefined → the skill is not advertised. */
  computerAvailable?: boolean;
  /** Where `chat_attach` keeps the bytes it sends (the session's store and
   * id). Omitted → the tool is not built: without a store there is nowhere
   * for a file to go, and the card would link nothing. */
  attach?: ChatAttachTarget;
  /** Where the `visual` tool publishes (the session's asset store and id).
   * Code mode has it in addition to `chat_attach`: the `visual:` reference
   * puts an image INSIDE the reply's markdown, which is what a coding
   * answer with a chart wants. Omitted → the tool is not built. */
  visuals?: VisualTarget;
  /** The file and command backends the tools run against. Omitted → this
   * machine's workspace (`hostBackends`); stella sessions pass the VM's.
   * The workspace itself still supplies the skill catalog and the sandbox
   * for anything that reads project files directly. */
  backends?: ToolBackends;
  /** The user's web-search provider. Omitted → `web_search` / `web_fetch`
   * are not built: without a configured provider there is nothing to search
   * with, and a tool that can only fail is not worth showing the model. */
  webSearch?: SearchProvider;
}

/** The two backends a tool set is built on. */
export interface ToolBackends {
  files: FileBackend;
  runner: CommandRunner;
}

/** Build the standard coding tool set, sandboxed to a workspace. */
export function createCodingTools(
  workspace: Workspace,
  options: Partial<ToolFactoryOptions> = {},
): Tool[] {
  const backends = options.backends ?? hostBackends(workspace);
  const { files, runner } = backends;

  return [
    ...fileTools(files),
    createBashTool({
      files,
      runner,
      env: options.env,
      safety: options.safety,
    }),
    ...(options.background !== undefined
      ? createAsyncBashTools({
        manager: options.background,
        files,
        safety: options.safety,
      })
      : []),
    createEvalTool({ safety: options.safety }),
    ...(options.attach !== undefined
      ? [createChatAttachTool({ files, ...options.attach })]
      : []),
    ...(options.visuals !== undefined
      ? [createVisualTool({ files, ...options.visuals })]
      : []),
    ...(options.webSearch !== undefined
      ? createWebSearchTools(options.webSearch)
      : []),
    createSkillTool({
      skills: sessionSkills(workspace.folders, {
        browserAvailable: options.browserAvailable,
        computerAvailable: options.computerAvailable,
      }),
    }),
    ...(options.ask !== undefined ? [createAskTool(options.ask)] : []),
    ...(options.todo !== undefined ? [createTodoTool(options.todo)] : []),
    ...(options.task !== undefined ? options.task.parentTools() : []),
  ];
}

/**
 * Build the tool set of a stella session: the coding tools, working inside
 * the session's virtual machine instead of a workspace on this host.
 *
 * What differs from {@link createCodingTools} is what "here" means, not which
 * tools exist:
 *
 * - the file and command backends come from the caller (the VM), so every
 *   path and every command is resolved and run inside the machine;
 * - `eval` is absent. It runs JavaScript in the SERVER process, so handing it
 *   to a session whose whole premise is isolation would be a hole in that
 *   premise. The machine's own `node` (reached through bash) is the way to
 *   run code there;
 * - the screen tools (`vm_screenshot` / `vm_act`) are preloaded, because a
 *   GUI is the one thing a shell cannot reach and an agent must know it can
 *   look;
 * - `history_search` is preloaded: the conversation outlives any one
 *   context window, and the turns a checkpoint condensed away are still in
 *   the message store — but the agent has to know it can ask for them.
 * - `todo` is absent. Its plan is shown in a progress panel, and stella's
 *   conversation has no panels (the agent says what it is doing in its own
 *   words), so the tool would collect a plan nobody reads — one more schema
 *   on every request and one more round trip per plan change.
 * - `ask` is absent too. A conversation whose person is watching the machine
 *   answers in words or with a card; a blocking question the server shows in
 *   a panel would be a surface this mode does not have, and it would leave
 *   the run waiting for an answer nothing draws.
 * - `visual` is replaced by `chat_attach`: the visual tool publishes an image
 *   the reply has to link with markdown, while a conversation wants the file
 *   itself — an image inline, anything else as a download.
 * - `identity` and `agent_create` are NOT here: they belong to the
 *   conversation's own agent, so they live in the session's main registry
 *   and are reached through tool_search (TC-7). A sub-agent must not rewrite
 *   the identity of the agent that started it, nor create siblings the user
 *   never asked for.
 * - skills come from the machine and from the user's global set (see
 *   vm/skills.ts), not from a workspace folder chain.
 *
 * Everything else — sub-agents, discoverable tools through the registry — is
 * unchanged: stella is a different place to work, not a reduced agent.
 */
export function createStellaTools(options: {
  backends: ToolBackends;
  /** The session's working folder inside the machine: bash and async_bash
   * start here when the model omits `cwd`. */
  cwd?: string;
  /** Skills discovered for this session (vm/skills.ts), already merged with
   * the built-ins the session is entitled to. */
  skills: SkillDef[];
  screen: Tool[];
  /** `agent_create`: add another stella agent (one of the sidebar's agents).
   * Superseded by the main registry (TC-7): a tool that belongs to this
   * conversation's own agent is reached through tool_search, so it never
   * reaches a sub-agent. Kept out of this option bag on purpose. */
  agents?: Tool;
  /** `chat_ui`: show a card in the chat. */
  chatUi?: Tool;
  /** `history_search`: the conversation's own saved history. Omitted → the
   * tool is not built (a caller without a message store has nothing to
   * search). */
  history?: Tool;
  /** `identity`: the agent's own text about itself. Like `agents`, it is
   * reached through the session's main registry (see agent/factory.ts), so
   * it is deliberately not part of this set: a tool a sub-agent could find
   * would let it rewrite the identity of the agent that started it. */
  identity?: Tool;
  /** `chat_attach`: hand files to the user. Omitted → the tool is not built
   * (a caller with no attachment store has nowhere to keep the bytes). */
  attach?: ChatAttachTarget;
  /** The user's web-search provider (see ToolFactoryOptions.webSearch). */
  webSearch?: SearchProvider;
  background?: BackgroundProcessManager;
  task?: TaskHub;
  safety?: CommandSafety;
}): Tool[] {
  const { files, runner } = options.backends;
  return [
    ...fileTools(files),
    createBashTool({
      files,
      runner,
      safety: options.safety,
      defaultCwd: options.cwd,
    }),
    ...(options.background !== undefined
      ? createAsyncBashTools({
        manager: options.background,
        files,
        safety: options.safety,
        defaultCwd: options.cwd,
      })
      : []),
    ...options.screen,
    ...(options.chatUi !== undefined ? [options.chatUi] : []),
    ...(options.attach !== undefined
      ? [createChatAttachTool({ files, ...options.attach })]
      : []),
    ...(options.history !== undefined ? [options.history] : []),
    ...(options.webSearch !== undefined
      ? createWebSearchTools(options.webSearch)
      : []),
    createSkillTool({ skills: options.skills }),
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
    ...(options.webSearch !== undefined
      ? createWebSearchTools(options.webSearch)
      : []),
    // Only global skills apply (no workspace folders to discover from).
    createSkillTool({
      skills: sessionSkills([], {
        browserAvailable: options.browserAvailable,
        computerAvailable: options.computerAvailable,
      }),
    }),
    ...(options.ask !== undefined ? [createAskTool(options.ask)] : []),
    ...(options.todo !== undefined ? [createTodoTool(options.todo)] : []),
  ];
}
