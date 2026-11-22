/**
 * The tools one session is built with.
 *
 * Two sets, for two different reasons. The PRELOADED set is what the model sees
 * without asking, and it follows where the session works (its machine, a coding
 * workspace, the folder-less chat) — see buildSessionTools. The DISCOVERABLE
 * set is what `tool_search` / `tool_call` can find, and it follows the
 * capabilities a session happens to have (the browser lab, computer use, the
 * PDF reader, MCP servers, a stella conversation's own tools) — see
 * seedDiscoverableTools.
 *
 * The scripting tool call turns the preloaded set into the catalog `execute`
 * calls from instead of handing it to the model, which is a third, separate
 * step (applyCodeExecution).
 */

import {
  BROWSER_TOOL_NAMES,
  createBrowserToolsFrom,
} from "../browser/tools.ts";
import { createHostCodeRuntime } from "../code-execution/host.ts";
import { createVmCodeRuntime } from "../code-execution/vm.ts";
import { COMPUTER_TOOL_NAMES, createComputerTools } from "../computer/tools.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import {
  createMcpAdminTools,
  MCP_ADMIN_TOOL_NAMES,
} from "../mcp/manage-tools.ts";
import { createPdfTools, PDF_TOOL_NAMES } from "../pdf/tools.ts";
import type { Tool } from "../ports/tool.ts";
import {
  TOOL_AGENT_CREATE,
  TOOL_CALL,
  TOOL_EXECUTE,
  TOOL_IDENTITY,
  TOOL_ROUTINE_CREATE,
  TOOL_ROUTINE_DELETE,
  TOOL_ROUTINE_LIST,
  TOOL_ROUTINE_RUN,
  TOOL_ROUTINE_UPDATE,
  TOOL_SHARE_DISCONNECT,
  TOOL_SHARE_DOWNLOAD,
  TOOL_SHARE_REQUEST,
  TOOL_SHARE_UPLOAD,
  TOOL_VM_ENV,
} from "../shared/mod.ts";
import { ToolCatalog } from "../tools/catalog.ts";
import { createExecuteTool } from "../tools/execute.ts";
import {
  createChatTools,
  createCodingTools,
  createStellaTools,
} from "../tools/mod.ts";
import type { SessionToolRegistries } from "../tools/registries.ts";
import { renderToolSdk } from "../tools/sdk.ts";
import { createToolSearchTool } from "../tools/search-tool.ts";
import { createShareRequestTools } from "../tools/share-request.ts";
import { createShareTransferTools } from "../tools/share-transfer.ts";
import type { SessionPoolDeps } from "./deps.ts";
import type { SessionHubs } from "./session-hubs.ts";
import type { SessionWhere } from "./session-location.ts";

/** Names of the routine tools (discoverable through tool_search): removed
 * from every session that is not stella's, added back when it is. */
const ROUTINE_TOOL_NAMES = [
  TOOL_ROUTINE_CREATE,
  TOOL_ROUTINE_LIST,
  TOOL_ROUTINE_UPDATE,
  TOOL_ROUTINE_DELETE,
  TOOL_ROUTINE_RUN,
];

/** Names of the tools that belong to a stella conversation's own agent
 * (discoverable, main-only): removed from every session that is not
 * stella's, added to that session's main registry when it is. */
const STELLA_AGENT_TOOL_NAMES = [TOOL_IDENTITY, TOOL_AGENT_CREATE];

/** Names of the environment-variable tool (discoverable, main-only): the
 * value it asks for belongs to the machine, and a sub-agent cannot put a
 * dialog in front of the user. Removed from every session that is not a
 * stella conversation, added to that session's main registry when it is. */
const VM_ENV_TOOL_NAMES = [TOOL_VM_ENV];

/** Names of the two transfer tools. They are discovered rather than
 * preloaded: a conversation that lends nothing has no use for them, and the
 * lent-folder announcement is what tells the agent they exist. */
const SHARE_TRANSFER_TOOL_NAMES = [TOOL_SHARE_UPLOAD, TOOL_SHARE_DOWNLOAD];

/** Names of the tools that ask about a lent folder (`share_request` /
 * `share_disconnect`). Discovered for the same reason as the transfer pair,
 * main-only because a sub-agent must not put a card in front of the user or
 * end a loan its parent is still working in, and stella-only because folder
 * lending is stella's (code mode has workspace folders of its own). */
const SHARE_REQUEST_TOOL_NAMES = [TOOL_SHARE_REQUEST, TOOL_SHARE_DISCONNECT];

/**
 * The tools the model sees without asking: the set follows where the
 * session works (machine, coding workspace, chat), not which extras are
 * available — those are discoverable through the registry (see
 * seedDiscoverableTools).
 */
export function buildSessionTools(
  deps: SessionPoolDeps,
  session: SessionInfo,
  workspace: Workspace,
  where: SessionWhere,
  hubs: SessionHubs,
): Tool[] {
  const { stella, chat, backends, browserAvailable } = where;
  if (stella !== undefined) {
    // stella's tool set: the coding tools over the machine's backends, the
    // screen and semantic tools, and the machine's own skill catalog.
    // `eval` is deliberately absent (see createStellaTools), and so are
    // `ask` (no panel to answer it) and `visual`/`chat_attach` (replaced by
    // send_chat, the conversation's only way to speak). `todo` is there
    // without a panel: its plan is the run's memory of a request with more
    // than one part.
    return createStellaTools({
      backends,
      cwd: stella.cwd,
      // A getter: the machine re-reads the catalog when a conversation is
      // opened, and the tool has to follow it (a skill the agent wrote is
      // loadable afterwards).
      skills: () => stella.skills(),
      screen: [...stella.screenTools, ...stella.semanticTools],
      sendChat: {
        store: deps.attachments,
        sessionId: session.id,
      },
      history: stella.historyTool,
      todo: hubs.todo,
      task: hubs.tasks,
      // Long builds and dev servers are the machine's work too: the
      // manager spawns them through the machine's spawner (setsid), so a
      // run does not have to wait inside one bash call.
      background: hubs.background,
      safety: deps.commandSafety,
      webSearch: where.webSearch,
    });
  }
  if (chat) {
    return createChatTools({
      ask: where.askTool ? hubs.ask : undefined,
      todo: hubs.todo,
      safety: deps.commandSafety,
      browserAvailable,
      computerAvailable: where.computerAvailable,
      mcpAdmin: where.mcpAdmin !== undefined,
      webSearch: where.webSearch,
      // A chat session has no file tools: no skill-authoring guide, but
      // the shared and global skills are still loadable.
      ...(deps.appSkillDirs !== undefined
        ? { appSkillDirs: deps.appSkillDirs }
        : {}),
      ...(deps.globalSkillDirs !== undefined
        ? { globalSkillDirs: deps.globalSkillDirs }
        : {}),
    });
  }
  return createCodingTools(workspace, {
    background: hubs.background,
    ask: where.askTool ? hubs.ask : undefined,
    todo: hubs.todo,
    task: hubs.tasks,
    safety: deps.commandSafety,
    browserAvailable,
    computerAvailable: where.computerAvailable,
    mcpAdmin: where.mcpAdmin !== undefined,
    attach: { store: deps.attachments, sessionId: session.id },
    visuals: { store: deps.visuals, sessionId: session.id },
    backends,
    webSearch: where.webSearch,
    ...(deps.appSkillDirs !== undefined
      ? { appSkillDirs: deps.appSkillDirs }
      : {}),
    ...(deps.globalSkillDirs !== undefined
      ? { globalSkillDirs: deps.globalSkillDirs }
      : {}),
  });
}

/**
 * The tool set the model is given when the scripting tool call is on:
 * `execute`, and nothing else.
 *
 * The set built by buildSessionTools is not discarded — it becomes the catalog
 * a program calls tools from, together with the session's discoverable
 * registry. The preloaded tools are also rendered as a compact TypeScript SDK
 * in the system prompt; the discoverable registry is not, so a tool added after
 * the agent opened is found through tool_search.
 *
 * Both `execute` and `tool_call` are left out of the catalog: a program running
 * a program is a way to multiply the limits one of them enforces, and tool_call
 * is what execute replaces.
 */
export function applyCodeExecution(
  deps: SessionPoolDeps,
  tools: Tool[],
  where: SessionWhere,
  registries: SessionToolRegistries,
  sessionId: string,
): { tools: Tool[]; sdk?: string } {
  if (!where.codeExecution) return { tools };
  // The search tool is built first and reads the catalog through a
  // closure: the catalog has to contain tool_search, and tool_search has
  // to search the catalog. Only the call order matters, never the
  // construction order.
  const search = createToolSearchTool(() => catalog, "code");
  const catalog = new ToolCatalog({
    tools: () => [...tools, search],
    registry: () => registries.main,
    exclude: [TOOL_EXECUTE, TOOL_CALL],
  });
  // A stella program runs under the machine's own node and asks the
  // server for each tool call; every other session runs it in the
  // server-process sandbox (see code-execution/).
  const codeRuntime =
    where.stella !== undefined
      ? createVmCodeRuntime({
          exec: where.stella.exec,
          channel: where.stella.channel,
          cwd: where.stella.cwd,
        })
      : createHostCodeRuntime();
  return {
    tools: [
      createExecuteTool({
        catalog,
        runtime: codeRuntime,
        cwd: where.stella?.cwd ?? process.cwd(),
        safety: deps.commandSafety,
        store: deps.codeStore,
        sessionId,
      }),
    ],
    sdk: renderToolSdk([...tools, search]),
  };
}

/**
 * Seed the session's tool registries with the tools that are discovered rather
 * than preloaded: MCP (by the attachment), the browser lab, computer use, the
 * PDF reader, and — for a stella session — the routines, the two tools of the
 * conversation's own agent, and `vm_env`.
 *
 * The registry is reused across agent rebuilds, so every family is
 * removed-then-added: a capability that went away (a backend detached, the
 * machine stopped) must not survive as a stale tool, and a workspace folder
 * change must apply without old paths.
 */
export function seedDiscoverableTools(
  deps: SessionPoolDeps,
  where: SessionWhere,
  registries: SessionToolRegistries,
  sessionId: string,
): void {
  if (where.browserAvailable) {
    registries.addShared(createBrowserToolsFrom(() => deps.browser?.()));
  } else {
    registries.removeShared(BROWSER_TOOL_NAMES);
  }
  if (where.computerAvailable()) {
    registries.addShared(
      createComputerTools({ resolveHost: () => deps.computer?.() }),
    );
  } else {
    registries.removeShared(COMPUTER_TOOL_NAMES);
  }
  // The PDF page-as-image tool needs no host backend beyond the workspace
  // itself, so every coding session seeds it; a chat-only session has no
  // folders to resolve against and removes it.
  registries.removeShared(PDF_TOOL_NAMES);
  if (!where.chatOnly) {
    registries.addShared(createPdfTools({ files: where.backends.files }));
  }
  // Bytes between this session's own files and a folder lent from the
  // user's computer. `read` and `write` reach /lend too, but only as text,
  // so this pair is how a picture or an archive crosses. Discovered from
  // the loan's own announcement (share/context.ts) rather than preloaded:
  // a conversation that lends nothing pays nothing for them.
  registries.removeShared(SHARE_TRANSFER_TOOL_NAMES);
  if (!where.chatOnly) {
    registries.addShared(createShareTransferTools(where.backends.files));
  }
  // The app-level MCP server config is shared by every workspace and
  // outlives this conversation, so it belongs to the session's main agent
  // alone: a sub-agent must not add a server that keeps running after its
  // run ends. Discovered through tool_search rather than preloaded — most
  // conversations never touch the config.
  registries.main.removeTools(MCP_ADMIN_TOOL_NAMES);
  if (where.mcpAdmin !== undefined) {
    registries.addMainOnly(createMcpAdminTools(where.mcpAdmin));
  }
  // Routines and the conversation's own agent belong to a stella
  // conversation only, and to its MAIN agent alone: a sub-agent must not
  // schedule work that outlives its run, rewrite its parent's identity or
  // create siblings the user never asked for.
  registries.main.removeTools(ROUTINE_TOOL_NAMES);
  registries.main.removeTools(STELLA_AGENT_TOOL_NAMES);
  registries.main.removeTools(VM_ENV_TOOL_NAMES);
  // Asking the user for a folder, and ending a loan: stella's, main-only
  // and discoverable (the built-in `folder-share` skill is what tells the
  // agent they exist). The grants are read per call, so a loan made while
  // the run is elsewhere is there for the next answer.
  registries.main.removeTools(SHARE_REQUEST_TOOL_NAMES);
  if (where.stella !== undefined && deps.shareRequests !== undefined) {
    registries.addMainOnly(
      createShareRequestTools({
        grants: () => deps.shares?.()?.grantsFor(sessionId) ?? [],
        requests: deps.shareRequests.for(sessionId),
      }),
    );
  }
  if (where.stella !== undefined) {
    registries.addMainOnly(where.stella.routineTools);
    registries.addMainOnly([
      where.stella.identityTool,
      where.stella.agentTool,
      where.stella.envTool,
    ]);
  }
}
