import type { AgentMessage } from "../ai/types.ts";
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
  return stableJson(a.servers) === stableJson(b.servers);
}

/** Key-sorted JSON (recursively), so equality is independent of object key
 * order. Used by sameMcpConfig for small configs only. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) =>
        `${JSON.stringify(key)}:${
          stableJson(
            (value as Record<string, unknown>)[key],
          )
        }`
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
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
    const model = this.deps.requireModel(
      session.modelProvider,
      session.modelId,
    );

    // One shared MCP attachment per session: its server processes serve
    // every agent of the session (the main agent and the sub-agents) and
    // survive agent rebuilds while the merged config is unchanged. A
    // changed config rebuilds the attachment and tears down the old
    // processes. Config errors and failed servers are reported once per
    // attachment, so a rebuild must not re-report them.
    const mergedMcp = this.deps.loadMergedMcp(workspace);
    let mcp = resources.mcp;
    if (mcp === undefined || !sameMcpConfig(mcp.config, mergedMcp.config)) {
      const previous = mcp;
      if (previous !== undefined) {
        log.debug(`session ${session.id}: MCP config changed, rebuilding`);
      }
      mcp = new McpAttachment(
        new McpManager(
          mergedMcp.config,
          workspace.folders[0] ?? Deno.cwd(),
          this.deps.mcpOAuth,
        ),
        mergedMcp.config,
      );
      resources.mcp = mcp;
      // A config change builds fresh tools, so the registries are rebuilt
      // with the attachment — stale tools must not survive it. A rebuild
      // with an unchanged config reuses both.
      resources.registries = new SessionToolRegistries();
      if (previous !== undefined) void previous.manager.close();
      this.reportMcpProblems(
        session.id,
        resources,
        mergedMcp,
        mcp,
        isCurrentAttachment,
      );
    }
    // The two tool registries of the session, created with the attachment
    // above and reused across agent rebuilds so the session's discoverable
    // tools survive them. The main agent's attachMcp fills both: what
    // describes where the session works (MCP, the browser lab, computer
    // use, the PDF reader) is shared, while tools that belong to this
    // conversation's own agent stay in `main` only (see tools/registries.ts).
    const registries = resources.registries!;
    // The browser-lab tools live in the session's tool registry
    // (discoverable via tool_search), never preloaded into the LLM context
    // — the same contract as MCP tools. Seeded at open so every agent of
    // the session — the main agent and the sub-agents — finds them from
    // the first prompt. The tools resolve the backend at execute time, so
    // a later setBrowserBackend (replacement or detach) is honored even
    // without a rebuild; when the backend is gone at open, the seeded
    // tools are removed instead — a rebuilt session then finds no browser
    // tools, matching the detach contract.
    const browser = this.deps.browser !== undefined
      ? this.deps.browser()
      : undefined;
    // Whether the session advertises the browser-lab: the tools are
    // seeded below, and the built-in web-browser skill (main agent,
    // sub-agents, prompt listing) is gated on the same value.
    const browserAvailable = browser !== undefined;
    if (browser !== undefined) {
      registries.addShared(
        createBrowserToolsFrom(() => this.deps.browser?.()),
      );
    } else {
      registries.removeShared(BROWSER_TOOL_NAMES);
    }
    // The computer-use tools follow the same contract as the browser-lab
    // ones: seeded into the session's registry (never preloaded), removed
    // when the session must not drive the machine. The getter is the single
    // gate — it answers undefined when no host is attached on this platform
    // or the user has not enabled the feature — so enabling applies to the
    // sessions opened afterwards and disabling stops an already-seeded
    // session on its next call.
    const computer = this.deps.computer !== undefined
      ? this.deps.computer()
      : undefined;
    const computerAvailable = computer !== undefined;
    // The user's web-search provider. Resolved once per open (the tools hold
    // it, so a rebuild picks up a changed default) and undefined when the
    // user has not configured one; the tools are then simply absent.
    const webSearch: SearchProvider | undefined = this.deps.webSearch?.();
    if (computer !== undefined) {
      registries.addShared(
        createComputerTools({ resolveHost: () => this.deps.computer?.() }),
      );
    } else {
      registries.removeShared(COMPUTER_TOOL_NAMES);
    }
    // Chat sessions ("simple chat" without a workspace) have no shell or
    // sub-agent surface: the background-command manager, the task hub and
    // the runtime resolver are skipped, and the tool set is the chat one.
    // stella is the exception below: its row shares that workspace, but its
    // tools run inside the machine and it keeps the full surface.
    const chat = workspace.chat;
    // Where this session's tools run. A stella session works inside its
    // virtual machine (resolved once per open, so every tool of the agent and
    // every sub-agent it spawns works in the same place); every other session
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
    // stella's conversation row lives in the folder-less chat workspace (it
    // has no folders of its own — its files are in the machine), but it is
    // NOT a chat session: it has a shell, background commands and
    // sub-agents. The two flags are therefore read together everywhere the
    // chat set would otherwise suppress a surface.
    const chatOnly = chat && stella === undefined;
    // The PDF page-as-image tool lives in the session's tool registry
    // (discoverable via tool_search), never preloaded into the LLM
    // context — the same contract as MCP and browser-lab tools. Unlike
    // the browser-lab tools it needs no host backend beyond the workspace
    // itself, so every coding session seeds it; chat-only sessions (no
    // workspace folders to resolve against) remove it. Remove-then-add
    // rebuilds the sandbox on every open, so workspace folder changes
    // apply without stale paths (the registry itself is reused across
    // agent rebuilds).
    registries.removeShared(PDF_TOOL_NAMES);
    if (!chatOnly) {
      registries.addShared(createPdfTools({ files: backends.files }));
    }
    // The routine tools are discoverable rather than preloaded: a routine is
    // created once and fires on its own, so five definitions would cost every
    // turn of every conversation for nothing. Only a stella session has them:
    // a routine belongs to an agent's one ongoing conversation, and code mode
    // sessions are tabs the user opens and closes. They are the main agent's
    // alone: a sub-agent must not schedule work that outlives its own run.
    registries.main.removeTools(ROUTINE_TOOL_NAMES);
    if (stella !== undefined) registries.addMainOnly(stella.routineTools);
    // The two tools that belong to THIS conversation's agent: its identity
    // and creating another agent. They are discoverable (tool_search) rather
    // than preloaded — an agent that knows it may write about itself does,
    // and the definition costs a line on every turn otherwise — and they are
    // main-only, so a sub-agent cannot rewrite its parent's identity or
    // create siblings the user never asked for.
    registries.main.removeTools(STELLA_AGENT_TOOL_NAMES);
    if (stella !== undefined) {
      registries.addMainOnly([stella.identityTool, stella.agentTool]);
    }
    // Reuse the session's manager when one exists (agent rebuild); create
    // it on first open. Shared by the async_bash tools and the session
    // agent: the tools start/check/kill commands, the agent turns
    // completions into notifications. Commands die with the session (pool
    // close/delete/closeAll → killAll), not with the agent. Chat sessions
    // never build it (no async_bash tools).
    let background = resources.background;
    if (!chat && background === undefined) {
      background = new BackgroundProcessManager({
        sessionId: session.id,
        emit: (event) => this.deps.emit(event),
        ...(stella !== undefined ? { spawner: stella.backgroundSpawner } : {}),
      });
      resources.background = background;
    }
    // One hub per open agent: it holds the questions of the live run, so a
    // rebuild (which closes the old agent first) starts with a clean slate.
    const askHub = new AskHub(session.id, (event) => this.deps.emit(event));
    // Reuse the session's todo hub when one exists (agent rebuild): the
    // plan is the session's progress, not the agent's, so it must survive.
    // Created on first open; discarded when the session closes. Not created
    // for a stella session: its conversation has no progress panel, so the
    // plan would have no reader (see createStellaTools).
    let todo = resources.todos;
    if (todo === undefined && stella === undefined) {
      todo = new TodoHub(session.id, (event) => this.deps.emit(event));
      resources.todos = todo;
    }
    // Sub-agents run on the fast model when configured, otherwise on the
    // session model; the thinking level follows the chosen model's stored
    // level. One hub per session (it owns the live sub-agents, which
    // survive agent rebuilds). The runtime is resolved at spawn time, so
    // model/workspace/thinking-level changes apply to new sub-agents even
    // without a rebuild; the resolver itself is refreshed on every open
    // (it must never hold a stale session). Coding and stella sessions only
    // — the task tools are absent from chat sessions, which run in a workspace
    // without folders (sub-agents would get coding tools that resolve
    // nothing).
    let tasks = resources.tasks;
    if (!chatOnly) {
      const runtimeResolver = () => {
        const fast = this.deps.getFastModelInfo();
        const workspace = this.deps.requireWorkspace(session.workspaceId);
        // `eval` runs in the server process, so a stella session's
        // sub-agents must not have it (its tools all run inside the
        // machine; see generalTools).
        const evalTool = stella === undefined;
        if (fast !== undefined) {
          return {
            workspace,
            backends,
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
          backends,
          model,
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
      // browser availability gate (the web-browser built-in skill
      // in their skill tool), and the language their reports come back
      // in — re-read on every open, like the rest.
      tasks.setMcp(mcp, registries.subagent);
      tasks.setBrowserAvailable(browserAvailable);
      tasks.setComputerAvailable(computerAvailable);
      tasks.setWebSearch(webSearch);
      tasks.setLanguage(this.deps.getLanguage());
    } else {
      tasks = undefined;
    }
    const tools = stella !== undefined
      // stella's tool set: the coding tools over the machine's backends, the
      // screen tools, and the machine's own skill catalog. `eval` is
      // deliberately absent (see createStellaTools), and so are `ask`
      // (no panel to answer it) and `visual` (replaced by chat_attach).
      ? createStellaTools({
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
        task: tasks,
        safety: this.deps.commandSafety,
        webSearch,
      })
      : chat
      ? createChatTools({
        ask: askHub,
        todo,
        safety: this.deps.commandSafety,
        browserAvailable,
        computerAvailable,
        webSearch,
      })
      : createCodingTools(workspace, {
        background,
        ask: askHub,
        todo,
        task: tasks,
        safety: this.deps.commandSafety,
        browserAvailable,
        computerAvailable,
        attach: { store: this.deps.attachments, sessionId: session.id },
        visuals: { store: this.deps.visuals, sessionId: session.id },
        backends,
        webSearch,
      });
    // The system prompt is generated once per session, from the tool set
    // the session actually has (its guidelines are keyed on the preloaded
    // tools — see tools/prompt-sections.ts) and persisted as a snapshot:
    // the prompt is the session's identity, never a mirror of the files on
    // disk (workspace instructions are dynamic context instead, see
    // contextProviders below).
    let systemPrompt = session.systemPrompt;
    if (systemPrompt === undefined) {
      systemPrompt = this.deps.buildGeneratedPrompt(
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
      this.deps.updateSystemPrompt(session.id, systemPrompt);
    }
    // Dynamic context (skill catalog, workspace instructions, the date and
    // the on-demand-tools note) is published as transcript messages when it
    // changes, so an edit reaches an open session and the prompt above
    // stays stable — the request's first tokens are what the provider's
    // prompt cache serves.
    const contextProviders = [
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
      // The tool_search / tool_call pair exists exactly while the
      // session's registry holds something to discover; the note follows
      // the same condition, so a late MCP discovery publishes it instead
      // of rewriting the prompt.
      createMcpToolsProvider({
        searchable: () => !registries.main.isEmpty,
      }),
    ];
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
      backgroundManager: background,
      askHub,
      ...(stella !== undefined ? { handoverHub: stella.handoverHub } : {}),
      taskHub: tasks,
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
