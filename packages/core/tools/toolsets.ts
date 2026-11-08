import type { Workspace } from "../types/workspace.ts";
import type { SkillDef } from "../skills/discover.ts";
import {
  fileTools,
  hostBackends,
  sessionSkills,
  type ToolBackends,
} from "./tool-pieces.ts";
import { createBashTool } from "./bash.ts";
import { createAsyncBashTools } from "./background.ts";
import type { BackgroundProcessManager } from "./background.ts";
import { createEvalTool } from "./eval.ts";
import { type ChatAttachTarget, createChatAttachTool } from "./attach.ts";
import { createSendChatTool, type SendChatTarget } from "./send-chat.ts";
import { createVisualTool, type VisualTarget } from "./visual.ts";
import { createWebSearchTools } from "./web.ts";
import type { SearchProvider } from "../websearch/types.ts";
import type { Tool } from "./schema.ts";
import { createSkillTool } from "../skills/tool.ts";
import { type AskHub, createAskTool } from "./ask.ts";
import { createTodoTool, type TodoHub } from "./todo.ts";
import type { TaskHub } from "./task-hub.ts";
import type { CommandSafety } from "../safety/command-safety.ts";

export {
  fileTools,
  hostBackends,
  readOnlyInvestigationTools,
  sessionSkills,
  type ToolBackends,
} from "./tool-pieces.ts";

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
   * Omitted/undefined → the skill is not advertised.
   *
   * A getter rather than a value, unlike `browserAvailable`: the toggle can
   * be flipped while a session runs, and the run is not rebuilt for it (see
   * SessionPool.applyCapabilityChange). A captured boolean would keep
   * advertising (or hiding) the skill until the next open. */
  computerAvailable?: () => boolean;
  /** Whether this session's main agent holds the MCP administration tools
   * (`mcp_add` / `mcp_remove` / `mcp_list`, seeded by the session pool).
   * Gates the built-in mcp-servers skill the same way: a session that cannot
   * run them must not be pointed at them. Omitted → not advertised. */
  mcpAdmin?: boolean;
  /** Where `chat_attach` keeps the bytes it sends (the session's store and
   * id). Omitted → the tool is not built: without a store there is nowhere
   * for a file to go, and the card would link nothing. Code mode only: a
   * stella session speaks with `send_chat`, which sends files itself. */
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
  /** The mode's shared skills folders (see `appSkillDirs`): discovered into
   * the skill catalog and, on the host, added as an extra sandbox root so
   * the agent can write a skill every agent shares. Omitted → resolved from
   * the environment. */
  appSkillDirs?: string[];
  /** Override for the user's global skills directory (~/.agents/skills).
   * Tests pass a fixture so they never read the developer's own skills. */
  globalSkillDirs?: string[];
}

/** Build the standard coding tool set, sandboxed to a workspace.
 *
 * The list is a table rather than a chain of conditionals: a tool either
 * needs something the caller may not have (an option), or it does not, and
 * that is the one thing the table says. Adding a tool means adding a row —
 * the shape `...(... ? [x] : [])` that every row used to repeat is what
 * made the three sets drift apart. */
export function createCodingTools(
  workspace: Workspace,
  options: Partial<ToolFactoryOptions> = {},
): Tool[] {
  const backends = options.backends ??
    hostBackends(workspace, { appSkillDirs: options.appSkillDirs });
  const { files, runner } = backends;
  // Resolved per call, not once: a skill this agent writes during the run
  // (see the skill-authoring guide) must be loadable by the very next call,
  // and the catalog provider re-discovers on every turn.
  const skills = () =>
    sessionSkills(workspace.folders, {
      browserAvailable: options.browserAvailable,
      computerAvailable: options.computerAvailable?.(),
      mcpAdmin: options.mcpAdmin,
      // The coding set has the file tools the guide teaches.
      skillAuthoring: true,
      ...(options.appSkillDirs !== undefined
        ? { appSkillDirs: options.appSkillDirs }
        : {}),
      ...(options.globalSkillDirs !== undefined
        ? { globalDirs: options.globalSkillDirs }
        : {}),
    });
  // Each row: the tool(s), or nothing when the option it needs is absent.
  const rows: Array<Tool | Tool[] | undefined> = [
    fileTools(files),
    createBashTool({ files, runner, env: options.env, safety: options.safety }),
    options.background !== undefined
      ? createAsyncBashTools({
        manager: options.background,
        files,
        safety: options.safety,
      })
      : undefined,
    createEvalTool({ safety: options.safety }),
    options.attach !== undefined
      ? createChatAttachTool({ files, ...options.attach })
      : undefined,
    options.visuals !== undefined
      ? createVisualTool({ files, ...options.visuals })
      : undefined,
    options.webSearch !== undefined
      ? createWebSearchTools(options.webSearch)
      : undefined,
    createSkillTool({ skills }),
    options.ask !== undefined ? createAskTool(options.ask) : undefined,
    options.todo !== undefined
      ? createTodoTool(options.todo, { panel: true })
      : undefined,
    options.task?.parentTools(),
  ];
  return rows.flatMap((row) => row === undefined ? [] : [row].flat());
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
 * - the semantic tools (`vm_find` / `vm_do` / `vm_wait`) are preloaded next
 *   to them: addressing a control by role and name is the default way to
 *   drive a GUI, and an agent that only knows about coordinates reads pixels
 *   for everything. Both families ship because they answer different
 *   questions — see vm/semantic.ts;
 * - `history_search` is preloaded: the conversation outlives any one
 *   context window, and the turns a checkpoint condensed away are still in
 *   the message store — but the agent has to know it can ask for them.
 * - `todo` is here even though the conversation has no progress panel: the
 *   plan is not FOR the panel, it is how a run remembers the parts of a
 *   request it has not done yet. A long conversation condenses its history
 *   away, and the requests still outstanding go with it — the run then stops
 *   after the first one it finished. The description says the plan is
 *   recorded, not shown.
 * - `ask` is absent too. A conversation whose person is watching the machine
 *   answers in words or with a card; a blocking question the server shows in
 *   a panel would be a surface this mode does not have, and it would leave
 *   the run waiting for an answer nothing draws.
 * - `chat_attach` and `chat_ui` are replaced by `send_chat`: the conversation
 *   shows only what the agent SENDS, so "say something", "show a card" and
 *   "hand over a file" are one act. There is no `visual` either — an image
 *   goes through the same call, as a file.
 * - `identity` and `agent_create` are NOT here: they belong to the
 *   conversation's own agent, so they live in the session's main registry
 *   and are reached through tool_search (TC-7). A sub-agent must not rewrite
 *   the identity of the agent that started it, nor create siblings the user
 *   never asked for.
 * - searching the machine is the shell's job (grep, find), exactly as it is
 *   in code mode: there is one way to look through a directory tree.
 * - skills come from the machine and from the user's global set (see
 *   vm/skills.ts), not from a workspace folder chain.
 *
 * Everything else — sub-agents, discoverable tools through the registry — is
 * unchanged: stella is a different place to work, not a reduced agent.
 *
 * `identity` and `agent_create` are deliberately absent: both belong to the
 * conversation's own agent (its self-description, the siblings only the user
 * may ask for), so they live in the session's MAIN registry (see
 * agent/factory.ts and tools/registries.ts), where a sub-agent's tool_search
 * cannot reach them.
 */
export function createStellaTools(options: {
  backends: ToolBackends;
  /** The session's working folder inside the machine: bash and async_bash
   * start here when the model omits `cwd`. */
  cwd?: string;
  /** Skills discovered for this session (vm/skills.ts), already merged with
   * the built-ins the session is entitled to. A getter: the catalog is
   * re-read when the conversation is opened, and the tool follows it. */
  skills: () => SkillDef[];
  /** The machine's screen tools (`vm_screenshot` / `vm_act` / `vm_ask_user`)
   * and semantic tools (`vm_find` / `vm_do` / `vm_wait`), preloaded. */
  screen: Tool[];
  /** `send_chat`: the ONE way this conversation's agent says anything — the
   * words, a card, and files, in one call. Without it the agent cannot
   * speak at all (its own text is not shown), so a caller that omits it
   * builds a session that can work but never answer. */
  sendChat?: SendChatTarget;
  /** `history_search`: the conversation's own saved history. Omitted → the
   * tool is not built (a caller without a message store has nothing to
   * search). */
  history?: Tool;
  /** The todo hub backing the `todo` tool (see ToolFactoryOptions.todo).
   * Omitted → the tool is not built. There is no progress panel in this
   * mode, so the tool's description does not promise one. */
  todo?: TodoHub;
  /** The user's web-search provider (see ToolFactoryOptions.webSearch). */
  webSearch?: SearchProvider;
  background?: BackgroundProcessManager;
  task?: TaskHub;
  safety?: CommandSafety;
}): Tool[] {
  const { files, runner } = options.backends;
  const rows: Array<Tool | Tool[] | undefined> = [
    // The machine has `bash`, which brings grep, find and everything else
    // the shell already does well.
    fileTools(files),
    createBashTool({
      files,
      runner,
      safety: options.safety,
      defaultCwd: options.cwd,
    }),
    options.background !== undefined
      ? createAsyncBashTools({
        manager: options.background,
        files,
        safety: options.safety,
        defaultCwd: options.cwd,
      })
      : undefined,
    options.screen,
    options.sendChat !== undefined
      ? createSendChatTool({ files, ...options.sendChat })
      : undefined,
    options.history,
    options.todo !== undefined
      ? createTodoTool(options.todo, { panel: false })
      : undefined,
    options.webSearch !== undefined
      ? createWebSearchTools(options.webSearch)
      : undefined,
    createSkillTool({ skills: options.skills }),
    options.task?.parentTools(),
  ];
  return rows.flatMap((row) => row === undefined ? [] : [row].flat());
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
  const rows: Array<Tool | Tool[] | undefined> = [
    options.webSearch !== undefined
      ? createWebSearchTools(options.webSearch)
      : undefined,
    // Only the shared and global skills apply (no workspace folders to
    // discover from). No skill-authoring guide either: this set has no
    // `write` to write a skill with.
    createSkillTool({
      skills: () =>
        sessionSkills([], {
          browserAvailable: options.browserAvailable,
          computerAvailable: options.computerAvailable?.(),
          // A chat session can add an MCP server too: the config is
          // app-level, so it needs no workspace.
          mcpAdmin: options.mcpAdmin,
          ...(options.appSkillDirs !== undefined
            ? { appSkillDirs: options.appSkillDirs }
            : {}),
          ...(options.globalSkillDirs !== undefined
            ? { globalDirs: options.globalSkillDirs }
            : {}),
        }),
    }),
    options.ask !== undefined ? createAskTool(options.ask) : undefined,
    options.todo !== undefined
      ? createTodoTool(options.todo, { panel: true })
      : undefined,
  ];
  return rows.flatMap((row) => row === undefined ? [] : [row].flat());
}
