import type { AgentMessage } from "../ai/types.ts";
import type { Tool } from "../tools/schema.ts";
import type { StellaRuntime } from "../vm/runtime.ts";
import type { ContextProvider } from "../ai/context-providers.ts";
import type { ClientEvent } from "../types/event.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import {
  createChatTools,
  createCodingTools,
  createStellaTools,
} from "../tools/mod.ts";
import { BackgroundProcessManager } from "../tools/background.ts";
import { AskHub } from "../tools/ask.ts";
import { TodoHub } from "../tools/todo.ts";
import { TaskHub } from "../tools/task-hub.ts";
import type { McpConfig } from "../mcp/config.ts";
import { McpManager } from "../mcp/manager.ts";
import { McpAttachment } from "../mcp/attachment.ts";
import { SessionToolRegistries } from "../tools/registries.ts";
import { createSkillCatalogProvider } from "../skills/catalog.ts";
import { createInstructionsProvider } from "../memory/instructions.ts";
import { createDateProvider } from "./date-context.ts";
import { createMcpToolsProvider } from "../mcp/context.ts";
import { SessionAgent as SessionAgentImpl } from "./session-agent.ts";
import type { SessionAgent } from "./session-agent.ts";
import {
  BROWSER_TOOL_NAMES,
  createBrowserToolsFrom,
} from "../browser/tools.ts";
import { COMPUTER_TOOL_NAMES, createComputerTools } from "../computer/tools.ts";
import { createPdfTools, PDF_TOOL_NAMES } from "../pdf/tools.ts";
import {
  hostBackends,
  sessionSkills,
  type ToolBackends,
} from "../tools/toolsets.ts";
import { CoreError } from "../errors.ts";
import { createLogger } from "../log.ts";
import type { SearchProvider } from "../websearch/types.ts";
import type { SessionPoolDeps } from "./pool.ts";
import type { SessionResources } from "./pool.ts";
import {
  TOOL_AGENT_CREATE,
  TOOL_IDENTITY,
  TOOL_ROUTINE_CREATE,
  TOOL_ROUTINE_DELETE,
  TOOL_ROUTINE_LIST,
  TOOL_ROUTINE_RUN,
  TOOL_ROUTINE_UPDATE,
} from "../shared/mod.ts";
import { canonicalJson } from "../shared/digest.ts";

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

/** Module logger (debug-gated): attachment rebuilds are the first thing
 * to check when MCP tools misbehave. */
const log = createLogger("pool");

/** True when two merged configs describe the same servers, comparing their
 * canonical (key-sorted) JSON so a settings round-trip that reorders fields
 * does not spuriously tear down and respawn MCP server processes. */
function sameMcpConfig(a: McpConfig, b: McpConfig): boolean {
  return canonicalJson(a.servers) === canonicalJson(b.servers);
}

/** Where a session's tools run, plus the capability flags that follow from
 * it. Resolved once per open (see AgentFactory.resolveWhere) and threaded
 * through the phases, so no phase has to re-derive "is this stella?" or
 * re-invoke a capability getter. */
interface SessionWhere {
  /** The stella runtime when this is a stella session; undefined otherwise. */
  stella: StellaRuntime | undefined;
  /** The file/command backend every tool of the session works through. */
  backends: ToolBackends;
  /** The session's workspace is the folder-less chat one. */
  chat: boolean;
  /** A chat session without a machine: no shell, no sub-agents, no files. */
  chatOnly: boolean;
  /** The browser lab is attached to this server (gates its tools and skill). */
  browserAvailable: boolean;
  /** Computer use is available AND enabled (gates its tools and skill). */
  computerAvailable: boolean;
  /** The user's web-search provider, when one is configured. */
  webSearch: SearchProvider | undefined;
}

/** The per-session hubs one open agent is wired to. All but the ask hub
 * survive an agent rebuild (they live in SessionResources). */
interface SessionHubs {
  background: BackgroundProcessManager | undefined;
  ask: AskHub;
  todo: TodoHub | undefined;
  tasks: TaskHub | undefined;
}

/** Builds the live agent of a session with every runtime it needs
 * (MCP attachment, tool registry, hubs, tools). Extracted from
 * SessionPool.open so the pool stays a lifecycle manager: the factory owns
 * the wiring, the pool owns the map. */
export class AgentFactory {
  constructor(private readonly deps: SessionPoolDeps) {}

  /** Build the agent of a session, recording its runtime in `resources`. */
  open(
    session: SessionInfo,
    workspace: Workspace,
    messages: AgentMessage[],
    resources: SessionResources,
    isCurrentAttachment: (attachment: McpAttachment) => boolean,
  ): SessionAgent {
    // The wiring, phase by phase. Each phase owns one question and is
    // called in the order the next one depends on: where the session works
    // (and with which model), what it may discover, which hubs back its
    // tools, the tool set itself, the dynamic context, and finally the
    // agent. Reading `open` top to bottom is the sequence of decisions a
    // session is built from.
    const model = this.deps.requireModel(
      session.modelProvider,
      session.modelId,
    );
    const mcp = this.ensureMcpAttachment(
      session,
      workspace,
      resources,
      isCurrentAttachment,
    );
    const registries = resources.registries!;
    const where = this.resolveWhere(session, workspace);
    this.seedDiscoverableTools(where, registries);
    const hubs = this.buildHubs(session, where, resources, mcp);
    const tools = this.buildToolSet(session, workspace, where, hubs);
    const systemPrompt = this.ensureSystemPrompt(
      session,
      workspace,
      tools,
    );
    const contextProviders = this.buildContextProviders(
      workspace,
      where,
      registries,
    );
    const agent = new SessionAgentImpl({
      sessionId: session.id,
      systemPrompt,
      model,
      tools,
      messages,
      thinkingLevel: this.deps.getThinkingLevel(
        session.modelProvider,
        session.modelId,
      ),
      streamFn: this.deps.streamFn,
      messageRepo: this.deps.messageRepo,
      // Record what the model was sent, as far as prompt-cache reuse is
      // concerned: the first request of the session and every request whose
      // head changed or whose history was rewritten (see
      // session/request-shapes.ts). Append-extensions are not stored — they
      // reuse the previous prefix by construction.
      onRequestShape: (shape) => {
        if (shape.change === undefined) return;
        this.deps.requestShapeRepo.record(session.id, shape);
        if (shape.change === "initial") {
          log.debug(
            `session ${session.id}: first request recorded (${shape.messageCount} messages)`,
          );
          return;
        }
        // The two shapes that cost the provider's whole cached prefix are
        // worth a log line: they explain a cache-read drop on the next
        // assistant message.
        log.info(
          `session ${session.id}: request ${shape.change} ` +
            `(${shape.messageCount} messages, head ${shape.headHash})`,
        );
      },
      backgroundManager: hubs.background,
      askHub: hubs.ask,
      ...(where.stella !== undefined
        ? { handoverHub: where.stella.handoverHub }
        : {}),
      taskHub: hubs.tasks,
      toolRegistry: registries,
      contextProviders,
      imageAnalysisModel: this.deps.getImageAnalysisModel(),
      fastModel: this.deps.getFastModel(),
      language: this.deps.getLanguage(),
      compactionPolicy: () => this.deps.getCompactionPolicy(),
      renameSession: (name) => this.deps.renameSession(session.id, name),
      goalStore: {
        loadGoal: () => this.deps.loadGoal(session.id),
        saveGoal: (text, maxIterations) =>
          this.deps.saveGoal(session.id, text, maxIterations),
        updateGoal: (patch) => this.deps.updateGoal(session.id, patch),
        clearGoal: () => this.deps.clearGoal(session.id),
      },
      onEvent: (event) => {
        // Remember failures for clients that do not see the WS stream;
        // a new run clears the stale error.
        if (event.type === "session_error") {
          resources.lastError = event.message;
        } else if (event.type === "agent_start") {
          resources.lastError = undefined;
        }
        this.deps.emit(event);
      },
    });
    agent.attachMcp(mcp);
    resources.agent = agent;
    return agent;
  }

  /**
   * The session's shared MCP attachment, created or kept.
   *
   * One attachment per session: its server processes serve every agent of
   * the session (the main agent and the sub-agents) and survive agent
   * rebuilds while the merged config is unchanged. A changed config rebuilds
   * the attachment, tears down the old processes and (with it) the tool
   * registries — stale tools must not survive a config they came from.
   */
  private ensureMcpAttachment(
    session: SessionInfo,
    workspace: Workspace,
    resources: SessionResources,
    isCurrentAttachment: (attachment: McpAttachment) => boolean,
  ): McpAttachment {
    const merged = this.deps.loadMergedMcp(workspace);
    const existing = resources.mcp;
    if (
      existing !== undefined && sameMcpConfig(existing.config, merged.config)
    ) {
      return existing;
    }
    if (existing !== undefined) {
      log.debug(`session ${session.id}: MCP config changed, rebuilding`);
    }
    const attachment = new McpAttachment(
      new McpManager(
        merged.config,
        workspace.folders[0] ?? Deno.cwd(),
        this.deps.mcpOAuth,
      ),
      merged.config,
    );
    resources.mcp = attachment;
    resources.registries = new SessionToolRegistries();
    if (existing !== undefined) void existing.manager.close();
    this.reportMcpProblems(
      session.id,
      resources,
      merged,
      attachment,
      isCurrentAttachment,
    );
    return attachment;
  }

  /**
   * Where this session's tools run, and the capability flags that follow
   * from it. Resolved once per open, so every tool of the agent — and every
   * sub-agent it spawns — works in the same place.
   */
  private resolveWhere(
    session: SessionInfo,
    workspace: Workspace,
  ): SessionWhere {
    // A stella session works inside its virtual machine; every other session
    // works in this machine's workspace.
    const stella = session.stella === true
      ? this.deps.stellaRuntime?.(session)
      : undefined;
    if (session.stella === true && stella === undefined) {
      // Only reachable if the machine was detached while its session stayed
      // open. Failing loudly beats building a stella agent with host tools —
      // it would silently gain access to the user's own filesystem.
      throw new CoreError(
        "The stella machine is not available for this session",
        "unavailable",
      );
    }
    const backends: ToolBackends = stella !== undefined
      ? { files: stella.files, runner: stella.runner }
      : hostBackends(workspace);
    // A stella conversation row lives in the folder-less chat workspace (it
    // has no folders of its own — its files are in the machine), but it is
    // NOT a chat session: it has a shell, background commands and
    // sub-agents. The two flags are therefore read together everywhere the
    // chat set would otherwise suppress a surface.
    const chatOnly = workspace.chat && stella === undefined;
    // The browser-lab and computer-use tools follow one gate each: the
    // getter answers undefined when this machine cannot provide it (no
    // backend, no display, or the user has not enabled the feature). The
    // same value gates the built-in skills those tools come with.
    //
    // Computer use is code mode's: it drives THIS machine's screen, mouse and
    // keyboard, and a stella session works inside its own virtual machine —
    // the session gets the machine's screen tools (`vm_screenshot` /
    // `vm_act`), so a second, host-facing way to look at a screen would be a
    // way out of the machine as well as a duplicate of the one it has. The
    // gate is applied here, where "where this session works" is decided,
    // rather than in the tools, so the skill catalog and the capability flags
    // a sub-agent inherits agree with the tool set.
    const browser = this.deps.browser?.();
    const computer = stella === undefined ? this.deps.computer?.() : undefined;
    return {
      stella,
      backends,
      chat: workspace.chat,
      chatOnly,
      browserAvailable: browser !== undefined,
      computerAvailable: computer !== undefined,
      // The user's web-search provider. Resolved once per open (the tools
      // hold it, so a rebuild picks up a changed default) and undefined when
      // the user has not configured one; the tools are then simply absent.
      webSearch: this.deps.webSearch?.(),
    };
  }

  /**
   * Seed the session's tool registries with the tools that are discovered
   * rather than preloaded: MCP (by the attachment), the browser lab,
   * computer use, the PDF reader, and — for a stella session — the routines
   * and the two tools of the conversation's own agent.
   *
   * The registry is reused across agent rebuilds, so every family is
   * removed-then-added: a capability that went away (a backend detached, the
   * machine stopped) must not survive as a stale tool, and a workspace
   * folder change must apply without old paths.
   */
  private seedDiscoverableTools(
    where: SessionWhere,
    registries: SessionToolRegistries,
  ): void {
    if (where.browserAvailable) {
      registries.addShared(
        createBrowserToolsFrom(() => this.deps.browser?.()),
      );
    } else {
      registries.removeShared(BROWSER_TOOL_NAMES);
    }
    if (where.computerAvailable) {
      registries.addShared(
        createComputerTools({ resolveHost: () => this.deps.computer?.() }),
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
    // Routines and the conversation's own agent belong to a stella
    // conversation only, and to its MAIN agent alone: a sub-agent must not
    // schedule work that outlives its run, rewrite its parent's identity or
    // create siblings the user never asked for.
    registries.main.removeTools(ROUTINE_TOOL_NAMES);
    registries.main.removeTools(STELLA_AGENT_TOOL_NAMES);
    if (where.stella !== undefined) {
      registries.addMainOnly(where.stella.routineTools);
      registries.addMainOnly([
        where.stella.identityTool,
        where.stella.agentTool,
      ]);
    }
  }

  /**
   * The per-session hubs that back the tools and outlive an agent rebuild:
   * the ask hub (per agent), the todo plan, the background-command manager
   * and the sub-agent hub. Created on first open and reused afterwards, so a
   * model or workspace change does not lose the session's running work.
   */
  private buildHubs(
    session: SessionInfo,
    where: SessionWhere,
    resources: SessionResources,
    mcp: McpAttachment,
  ): SessionHubs {
    // Commands die with the session (pool close/delete/closeAll → killAll),
    // not with the agent. A chat session never builds it (no async_bash).
    let background = resources.background;
    if (!where.chat && background === undefined) {
      background = new BackgroundProcessManager({
        sessionId: session.id,
        emit: (event) => this.deps.emit(event),
        ...(where.stella !== undefined
          ? { spawner: where.stella.backgroundSpawner }
          : {}),
      });
      resources.background = background;
    }
    // One hub per open agent: it holds the questions of the live run, so a
    // rebuild (which closes the old agent first) starts with a clean slate.
    const ask = new AskHub(session.id, (event) => this.deps.emit(event));
    // The plan is the session's progress, not the agent's, so it survives a
    // rebuild. A stella conversation has no progress panel, so the plan
    // would have no reader.
    let todo = resources.todos;
    if (todo === undefined && where.stella === undefined) {
      todo = new TodoHub(session.id, (event) => this.deps.emit(event));
      resources.todos = todo;
    }
    // Sub-agents run on the fast model when configured, otherwise on the
    // session model; the thinking level follows the chosen model's stored
    // level. One hub per session (it owns the live sub-agents, which survive
    // agent rebuilds). The runtime is resolved at spawn time, so model /
    // workspace / thinking-level changes apply to new sub-agents even
    // without a rebuild.
    let tasks = resources.tasks;
    if (!where.chatOnly) {
      const runtimeResolver = () => {
        const fast = this.deps.getFastModelInfo();
        const workspace = this.deps.requireWorkspace(session.workspaceId);
        // `eval` runs in the server process, so a stella session's
        // sub-agents must not have it (its tools all run inside the
        // machine; see generalTools).
        const evalTool = where.stella === undefined;
        if (fast !== undefined) {
          return {
            workspace,
            backends: where.backends,
            model: fast.model,
            thinkingLevel: this.deps.getThinkingLevel(
              fast.provider,
              fast.modelId,
            ),
            eval: evalTool,
          };
        }
        return {
          workspace,
          backends: where.backends,
          model: this.deps.requireModel(
            session.modelProvider,
            session.modelId,
          ),
          thinkingLevel: this.deps.getThinkingLevel(
            session.modelProvider,
            session.modelId,
          ),
          eval: evalTool,
        };
      };
      if (tasks === undefined) {
        tasks = new TaskHub({
          sessionId: session.id,
          resolveRuntime: runtimeResolver,
          streamFn: this.deps.streamFn,
          safety: this.deps.commandSafety,
          language: this.deps.getLanguage(),
          compactionPolicy: () => this.deps.getCompactionPolicy(),
          emit: (event: ClientEvent) => this.deps.emit(event),
        });
        resources.tasks = tasks;
      } else {
        tasks.setRuntimeResolver(runtimeResolver);
      }
      // The sub-agents share the session's MCP attachment (their own
      // registry holds the shared tools the discovery merges in), the
      // capability gates (the built-in skills their skill tool offers) and
      // the language their reports come back in — re-read on every open.
      tasks.setMcp(mcp, resources.registries!.subagent);
      tasks.setBrowserAvailable(where.browserAvailable);
      tasks.setComputerAvailable(where.computerAvailable);
      tasks.setWebSearch(where.webSearch);
      tasks.setLanguage(this.deps.getLanguage());
    } else {
      tasks = undefined;
    }
    return { background, ask, todo, tasks };
  }

  /**
   * The tools the model sees without asking: the set follows where the
   * session works (machine, coding workspace, chat), not which extras are
   * available — those are discoverable through the registry (see
   * seedDiscoverableTools).
   */
  private buildToolSet(
    session: SessionInfo,
    workspace: Workspace,
    where: SessionWhere,
    hubs: SessionHubs,
  ): Tool[] {
    const { stella, chat, backends, browserAvailable } = where;
    if (stella !== undefined) {
      // stella's tool set: the coding tools over the machine's backends, the
      // screen tools, and the machine's own skill catalog. `eval` is
      // deliberately absent (see createStellaTools), and so are `ask`
      // (no panel to answer it) and `visual` (replaced by chat_attach).
      return createStellaTools({
        backends,
        cwd: stella.cwd,
        skills: stella.skills(),
        screen: stella.screenTools,
        chatUi: stella.chatUiTool,
        attach: {
          store: this.deps.attachments,
          sessionId: session.id,
        },
        history: stella.historyTool,
        task: hubs.tasks,
        safety: this.deps.commandSafety,
        webSearch: where.webSearch,
      });
    }
    if (chat) {
      return createChatTools({
        ask: hubs.ask,
        todo: hubs.todo,
        safety: this.deps.commandSafety,
        browserAvailable,
        computerAvailable: where.computerAvailable,
        webSearch: where.webSearch,
      });
    }
    return createCodingTools(workspace, {
      background: hubs.background,
      ask: hubs.ask,
      todo: hubs.todo,
      task: hubs.tasks,
      safety: this.deps.commandSafety,
      browserAvailable,
      computerAvailable: where.computerAvailable,
      attach: { store: this.deps.attachments, sessionId: session.id },
      visuals: { store: this.deps.visuals, sessionId: session.id },
      backends,
      webSearch: where.webSearch,
    });
  }

  /**
   * The session's system prompt: generated once, from the tool set the
   * session actually has (its guidelines are keyed on the preloaded tools —
   * see tools/prompt-sections.ts), then persisted as a snapshot. The prompt
   * is the session's identity, never a mirror of the files on disk
   * (workspace instructions are dynamic context instead).
   */
  private ensureSystemPrompt(
    session: SessionInfo,
    workspace: Workspace,
    tools: readonly Tool[],
  ): string {
    const existing = session.systemPrompt;
    if (existing !== undefined) return existing;
    const generated = this.deps.buildGeneratedPrompt(
      workspace,
      {
        provider: session.modelProvider,
        modelId: session.modelId,
      },
      tools.map((tool) => tool.name),
      // A stella session's prompt is the machine's plus WHO this agent is;
      // the persona comes from the agent registry, through the pool.
      session.stella === true
        ? (this.deps.stellaAgentPersona?.(session) ??
          { name: "Lumisca", role: "", agentId: session.agentId })
        : undefined,
    );
    this.deps.updateSystemPrompt(session.id, generated);
    return generated;
  }

  /**
   * The dynamic contexts (skill catalog, workspace instructions, the date,
   * the on-demand-tools note, a stella agent's identity). Published as
   * transcript messages when they change, so an edit reaches an open session
   * while the prompt above stays stable — the request's first tokens are
   * what the provider's prompt cache serves.
   */
  private buildContextProviders(
    workspace: Workspace,
    where: SessionWhere,
    registries: SessionToolRegistries,
  ): ContextProvider[] {
    const { stella, browserAvailable, computerAvailable } = where;
    return [
      // What the catalog IS depends on where the session works: a workspace
      // session discovers `.agents/skills`, and a stella session discovers
      // the machine's own directory plus the host's global and built-in set
      // (vm/skills.ts). Both resolve through the same seam, so the published
      // listing is exactly what the session's skill tool can load.
      createSkillCatalogProvider({
        skills: stella !== undefined
          ? () => stella.skills()
          : () =>
            sessionSkills(workspace.folders, {
              browserAvailable,
              computerAvailable,
              globalDirs: this.deps.globalSkillDirs,
            }),
      }),
      createInstructionsProvider({
        folders: workspace.folders,
        personal: this.deps.personalInstructions,
      }),
      // The identity is a stella agent's own text about itself; a session
      // without one (every other session) has nothing to publish.
      ...(stella !== undefined ? [stella.identityProvider] : []),
      createDateProvider(),
      // The tool_search / tool_call pair exists exactly while the session's
      // registry holds something to discover; the note follows the same
      // condition, so a late MCP discovery publishes it instead of
      // rewriting the prompt.
      createMcpToolsProvider({
        searchable: () => !registries.main.isEmpty,
      }),
    ];
  }

  /** Move a session to its current MCP config without rebuilding its agent
   * (the session is streaming, and replacing the agent would corrupt its
   * run). The attachment is swapped for a fresh one — new child processes,
   * new discovery — and the agent adopts it, so the servers behind
   * tool_search / tool_call and the status the settings UI reads follow the
   * new config while the run keeps the tools it started with. An idle
   * session is rebuilt instead, which reaches the same wiring through
   * open. */
  refreshMcp(
    session: SessionInfo,
    workspace: Workspace,
    resources: SessionResources,
    isCurrentAttachment: (attachment: McpAttachment) => boolean,
  ): void {
    const agent = resources.agent;
    if (agent === undefined) return;
    const merged = this.deps.loadMergedMcp(workspace);
    const previous = resources.mcp;
    // An unchanged config is no reason to respawn every server process.
    if (
      previous !== undefined && sameMcpConfig(previous.config, merged.config)
    ) {
      return;
    }
    const attachment = new McpAttachment(
      new McpManager(
        merged.config,
        workspace.folders[0] ?? Deno.cwd(),
        this.deps.mcpOAuth,
      ),
      merged.config,
    );
    resources.mcp = attachment;
    if (previous !== undefined) void previous.manager.close();
    this.reportMcpProblems(
      session.id,
      resources,
      merged,
      attachment,
      isCurrentAttachment,
    );
    agent.replaceMcpAttachment(attachment);
    // The sub-agents share the session's attachment, so the running ones are
    // re-pointed at the new tools too (see TaskHub.setMcp).
    const registries = resources.registries;
    if (registries !== undefined) {
      resources.tasks?.setMcp(attachment, registries.subagent);
    }
  }

  /** Report an MCP source's problems on the session: the merged config's
   * own errors right away, and the servers that failed to start once
   * discovery finished (a `session_error` event, remembered for clients
   * that do not read the event stream). The late report is guarded so only
   * an attachment the session still holds may speak for it. Shared by open
   * (agent rebuild) and refreshMcp (in-place reconnect). */
  private reportMcpProblems(
    sessionId: string,
    resources: SessionResources,
    merged: { config: McpConfig; errors: string[] },
    attachment: McpAttachment,
    isCurrentAttachment: (attachment: McpAttachment) => boolean,
  ): void {
    const emitError = (message: string) => {
      resources.lastError = message;
      this.deps.emit({ type: "session_error", sessionId, message });
    };
    for (const message of merged.errors) emitError(message);
    void attachment.ready.then(() => {
      // The session may have been closed or rebuilt (with a new
      // attachment) while discovery ran; only report for the attachment
      // the session still holds.
      if (!isCurrentAttachment(attachment)) return;
      const failed = attachment.manager
        .getStatus()
        .filter((s) => s.status === "error");
      if (failed.length > 0) {
        emitError(
          `MCP servers failed: ${
            failed.map((s) => `${s.name}: ${s.error}`).join("; ")
          }`,
        );
      }
    });
  }
}
