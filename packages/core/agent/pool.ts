import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { CoreError } from "../errors.ts";
import type { ThinkingLevel, TodoPhase } from "../shared.ts";
import type { ClientEvent } from "../types/event.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import { createCodingTools } from "../tools/mod.ts";
import { BackgroundProcessManager } from "../tools/background.ts";
import type { BackgroundCommandInfo } from "../tools/background.ts";
import { AskHub } from "../tools/ask.ts";
import { TodoHub } from "../tools/todo.ts";
import { TaskHub } from "../tools/task.ts";
import type { TaskInfo } from "../shared.ts";
import type { McpConfig } from "../mcp/config.ts";
import { McpManager } from "../mcp/manager.ts";
import { McpAttachment } from "../mcp/attachment.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import type { SessionAgent } from "./session-agent.ts";
import { SessionAgent as SessionAgentImpl } from "./session-agent.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { BrowserBackend } from "../browser/types.ts";

/** Everything the pool needs to build and manage agents, injected by
 * LumiscaCore so the pool stays free of repository wiring. */
export interface SessionPoolDeps {
  /** Resolve the model of a session (undefined when the model is gone). */
  getModel(provider: string, modelId: string): Model<Api> | undefined;
  /** The configured image-analysis model (undefined when unset): interprets
   * images as text for text-only session models. */
  getImageAnalysisModel(): Model<Api> | undefined;
  /** The configured fast model (undefined when unset): generates session
   * titles from the first user message. */
  getFastModel(): Model<Api> | undefined;
  /** The configured fast model with its provider/model ids (undefined when
   * unset or gone from the catalog). Sub-agents run on it, with its stored
   * thinking level. */
  getFastModelInfo():
    | { provider: string; modelId: string; model: Model<Api> }
    | undefined;
  /** Persist a new session title and notify clients. */
  renameSession(id: string, name: string): void;
  /** The stored thinking level of a model, clamped to what it supports. */
  getThinkingLevel(provider: string, modelId: string): ThinkingLevel;
  /** Full generated system prompt for a workspace (project memory +
   * personalization included); used only for legacy sessions that predate
   * prompt snapshots. `model` fills in the environment section. */
  buildGeneratedPrompt(
    workspace: Workspace,
    model?: { provider: string; modelId: string },
  ): string;
  /** Persist a rebuilt system prompt (legacy-session migration). */
  updateSystemPrompt(id: string, systemPrompt: string): void;
  streamFn: StreamFn;
  messageRepo: MessageRepo;
  /** Command safety check for the session's bash/eval/async_bash tools
   * (the fast model judges commands before they run). Always present; the
   * check itself is a no-op while the feature is disabled. */
  commandSafety: CommandSafety;
  /** Merged MCP config (app-level + workspace .mcp.json + plugins) for a
   * workspace, with collected config errors. */
  loadMergedMcp(workspace: Workspace): { config: McpConfig; errors: string[] };
  requireWorkspace(id: string): Workspace;
  /** Forward an agent event to every frontend listener. */
  emit(event: ClientEvent): void;
  /** The session's browser-lab backend (Desktop WebView host / CLI browser
   * host), or undefined when no browser surface is available — the agent
   * then gets no browser tools. A getter so a backend attached after the
   * pool was built (CLI lazy start) still reaches new agents. */
  browser?: () => BrowserBackend | undefined;
}

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

/** Everything one open session owns, keyed by session id. Consolidating the
 * per-session runtime state into one struct means a future resource is one
 * field here (and one clear in close/closeAll) instead of another parallel
 * map that must be kept in lockstep. */
interface SessionResources {
  /** The live agent (replaced on rebuild; absent when closed). */
  agent?: SessionAgent;
  /** Background-command manager. Owned by the pool (not the agent) so
   * background commands survive agent rebuilds — model and workspace
   * changes rebuild the agent while the session stays open, and the
   * commands must keep running. Stopped when the session closes. */
  background?: BackgroundProcessManager;
  /** Todo hub, with the same rebuild-survival reason as `background`. */
  todos?: TodoHub;
  /** Task hub, with the same rebuild-survival reason as `background`
   * (sub-agents run independently of the agent run). Aborted on close. */
  tasks?: TaskHub;
  /** Shared MCP attachment: its server processes serve every agent of the
   * session — the main agent and the sub-agents — and survive agent
   * rebuilds while the merged config is unchanged. Closed on close. */
  mcp?: McpAttachment;
  /** Tool registry (MCP tools discoverable via tool_search/call), rebuilt
   * together with the attachment when the config changes. */
  registry?: ToolRegistry;
  /** The last failure of the session, if any (cleared when a new run
   * starts). Lets non-WebSocket clients learn about failures of
   * fire-and-forget prompts. */
  lastError?: string;
  /** Whether the session is open with `headless: true` (the CLI `run` path).
   * Not persisted, but must survive agent rebuilds. Set on every open()
   * (a plain reopen clears it). */
  headless: boolean;
}

/**
 * Owns the live session agents: construction, lifecycle (open / close /
 * delete), and the streaming guards behind configuration changes. Kept out
 * of LumiscaCore so the core stays a thin facade over the repositories.
 */
export class SessionPool {
  private readonly sessions = new Map<string, SessionResources>();

  constructor(private readonly deps: SessionPoolDeps) {}

  get(id: string): SessionAgent | undefined {
    return this.sessions.get(id)?.agent;
  }

  require(id: string): SessionAgent {
    const agent = this.sessions.get(id)?.agent;
    if (!agent) {
      throw new CoreError(`Session is not open: ${id}`, "not_found");
    }
    return agent;
  }

  /** The last failure of a session, if any. Cleared when a new run starts.
   * Lets non-WebSocket clients (curl, the desktop shell) learn about
   * failures of fire-and-forget prompts instead of losing them. */
  lastError(id: string): string | undefined {
    return this.sessions.get(id)?.lastError;
  }

  /** The session's current todo plan (the todo tool); empty when the
   * session is not open or has no plan yet. Lets clients restore the
   * progress panel after a WS drop or page reload — todo events are
   * snapshots, but only mutations emit them, so they are not replayed. */
  getTodo(id: string): TodoPhase[] {
    return this.sessions.get(id)?.todos?.getPlan() ?? [];
  }

  /** Snapshots of the session's sub-agent tasks (the task tool); empty
   * when the session is not open or has no tasks yet. Restores the tasks
   * panel after a WS drop or page reload (task events are not replayed). */
  getTasks(id: string): TaskInfo[] {
    return this.sessions.get(id)?.tasks?.list() ?? [];
  }

  /** Snapshots of the session's background commands (the async_bash tool);
   * empty when the session is not open or has no commands yet. Restores
   * the background panel after a WS drop or page reload (background events
   * are not replayed). */
  getBackground(id: string): BackgroundCommandInfo[] {
    return this.sessions.get(id)?.background?.list() ?? [];
  }

  /** Build the agent of a session (replacing any existing one) and keep it
   * in memory. MCP tools attach asynchronously — they spawn server
   * processes — and errors are reported via session_error events, never
   * thrown here.
   *
   * `headless` (the CLI `run` path) changes the session's interaction with
   * the user: the ask tool auto-answers with the recommended/first option
   * instead of blocking, and title generation is skipped (no one sees it).
   * The flag is a runtime property of the open agent, not persisted — a
   * headless session reopened through the normal paths behaves like any
   * other session. */
  open(
    session: SessionInfo,
    workspace: Workspace,
    messages: AgentMessage[],
    options: { headless?: boolean } = {},
  ): SessionAgent {
    const model = this.deps.getModel(session.modelProvider, session.modelId);
    if (!model) {
      throw new CoreError(
        `Model not found: ${session.modelProvider}/${session.modelId}`,
        "not_found",
      );
    }
    const resources: SessionResources = this.sessions.get(session.id) ?? {
      headless: false,
    };
    // A new open records the current headless flag (an explicit headless
    // open sets it, a plain reopen clears it). Recorded only after the
    // model check above so a failed open leaves no stale state behind.
    resources.headless = options.headless ?? false;

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
      mcp = new McpAttachment(
        new McpManager(mergedMcp.config, workspace.folders[0] ?? Deno.cwd()),
        mergedMcp.config,
      );
      resources.mcp = mcp;
      // A config change builds fresh tools, so the registry is rebuilt
      // with the attachment — stale tools must not survive it. A rebuild
      // with an unchanged config reuses both.
      resources.registry = new ToolRegistry();
      if (previous !== undefined) void previous.manager.close();
      const emitError = (message: string) => {
        resources.lastError = message;
        this.deps.emit({
          type: "session_error",
          sessionId: session.id,
          message,
        });
      };
      for (const message of mergedMcp.errors) emitError(message);
      const attachment = mcp;
      void attachment.ready.then(() => {
        // The session may have been closed or rebuilt (with a new
        // attachment) while discovery ran; only report for the attachment
        // the session still holds.
        if (this.sessions.get(session.id)?.mcp !== attachment) return;
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
    // One tool registry per session, created with the attachment above and
    // reused across agent rebuilds so the session's discoverable tools
    // survive them. The main agent's attachMcp fills it once discovery
    // finishes; every agent of the session searches it.
    const registry = resources.registry!;
    // Reuse the session's manager when one exists (agent rebuild); create
    // it on first open. Shared by the async_bash tools and the session
    // agent: the tools start/check/kill commands, the agent turns
    // completions into notifications. Commands die with the session (pool
    // close/delete/closeAll → killAll), not with the agent.
    let background = resources.background;
    if (background === undefined) {
      background = new BackgroundProcessManager({
        sessionId: session.id,
        emit: (event) => this.deps.emit(event),
      });
      resources.background = background;
    }
    // One hub per open agent: it holds the questions of the live run, so a
    // rebuild (which closes the old agent first) starts with a clean slate.
    // Headless runs auto-answer every ask (recommended/first option).
    const askHub = new AskHub(session.id, (event) => this.deps.emit(event), {
      autoAnswer: options.headless ?? false,
    });
    // Reuse the session's todo hub when one exists (agent rebuild): the
    // plan is the session's progress, not the agent's, so it must survive.
    // Created on first open; discarded when the session closes.
    let todo = resources.todos;
    if (todo === undefined) {
      todo = new TodoHub(session.id, (event) => this.deps.emit(event));
      resources.todos = todo;
    }
    // Sub-agents run on the fast model when configured, otherwise on the
    // session model; the thinking level follows the chosen model's stored
    // level. One hub per session (it owns the live sub-agents, which
    // survive agent rebuilds). The runtime is resolved at spawn time, so
    // model/workspace/thinking-level changes apply to new sub-agents even
    // without a rebuild; the resolver itself is refreshed on every open
    // (it must never hold a stale session).
    const runtimeResolver = () => {
      const fast = this.deps.getFastModelInfo();
      const workspace = this.deps.requireWorkspace(session.workspaceId);
      if (fast !== undefined) {
        return {
          workspace,
          model: fast.model,
          thinkingLevel: this.deps.getThinkingLevel(
            fast.provider,
            fast.modelId,
          ),
        };
      }
      return {
        workspace,
        model,
        thinkingLevel: this.deps.getThinkingLevel(
          session.modelProvider,
          session.modelId,
        ),
      };
    };
    let tasks = resources.tasks;
    if (tasks === undefined) {
      tasks = new TaskHub({
        sessionId: session.id,
        resolveRuntime: runtimeResolver,
        streamFn: this.deps.streamFn,
        safety: this.deps.commandSafety,
        browser: this.deps.browser,
        emit: (event: ClientEvent) => this.deps.emit(event),
      });
      resources.tasks = tasks;
    } else {
      tasks.setRuntimeResolver(runtimeResolver);
    }
    // The sub-agents share the session's MCP attachment (general
    // sub-agents get the search/call tools over its registry).
    tasks.setMcp(mcp, registry);
    const browser = this.deps.browser !== undefined
      ? this.deps.browser()
      : undefined;
    const tools = createCodingTools(workspace, {
      background,
      ask: askHub,
      todo,
      task: tasks,
      safety: this.deps.commandSafety,
      browser,
    });
    // The system prompt is a per-session snapshot taken at creation
    // (custom prompts are stored verbatim). Only legacy sessions without a
    // stored prompt (created before snapshots) rebuild once — and the
    // rebuilt prompt is persisted right away so subsequent opens stay
    // frozen against AGENTS.md edits.
    let systemPrompt = session.systemPrompt;
    if (systemPrompt === undefined) {
      systemPrompt = this.deps.buildGeneratedPrompt(workspace, {
        provider: session.modelProvider,
        modelId: session.modelId,
      });
      this.deps.updateSystemPrompt(session.id, systemPrompt);
    }
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
      backgroundManager: background,
      askHub,
      taskHub: tasks,
      toolRegistry: registry,
      imageAnalysisModel: this.deps.getImageAnalysisModel(),
      fastModel: this.deps.getFastModel(),
      disableTitleGeneration: options.headless ?? false,
      renameSession: (name) => this.deps.renameSession(session.id, name),
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
    this.sessions.set(session.id, resources);
    return agent;
  }

  /** Close a session's agent (unsubscribing from background completions),
   * stop its background commands, abort its sub-agents, tear down its MCP
   * server processes, and discard its todo plan. The persisted session
   * stays; openSession rebuilds it with fresh managers and an empty plan. */
  close(id: string): void {
    const resources = this.sessions.get(id);
    if (!resources) return;
    resources.agent?.close();
    resources.background?.killAll();
    resources.tasks?.close();
    void resources.mcp?.manager.close();
    this.sessions.delete(id);
  }

  /** Close and forget a session entirely (persisted rows are deleted by
   * the caller). */
  delete(id: string): void {
    this.close(id);
  }

  /** Close every agent, stop every background command, abort every
   * sub-agent, and tear down every MCP attachment (core shutdown). */
  closeAll(): void {
    for (const resources of this.sessions.values()) {
      resources.agent?.close();
      resources.background?.killAll();
      resources.tasks?.close();
      void resources.mcp?.manager.close();
    }
    this.sessions.clear();
  }

  /** The shared "session is streaming" guard behind every configuration
   * change that rebuilds agents. */
  private assertNotStreaming(id: string): void {
    if (this.sessions.get(id)?.agent?.isStreaming) {
      throw new CoreError(`Session is already running: ${id}`, "conflict");
    }
  }

  /** Rebuild the agent of an open session. The old agent is never replaced
   * while streaming: the running loop would keep executing against the
   * same message array and duplicate DB rows. */
  rebuild(session: SessionInfo): void {
    const resources = this.sessions.get(session.id);
    if (resources?.agent === undefined) return;
    this.assertNotStreaming(session.id);
    const current = resources.agent;
    const workspace = this.deps.requireWorkspace(session.workspaceId);
    const messages = current.messages;
    const headless = resources.headless;
    current.close(); // also releases the old agent's MCP servers
    this.open(session, workspace, messages, { headless });
  }

  /** Refuse configuration changes while any listed session is streaming,
   * apply the mutation, then rebuild every affected agent. The streaming
   * checks and the mutation run in the same synchronous turn (no awaits in
   * between), so a prompt cannot start mid-apply. */
  applyChange(sessions: SessionInfo[], mutate: () => void): void {
    for (const session of sessions) {
      this.assertNotStreaming(session.id);
    }
    mutate();
    for (const session of sessions) {
      this.rebuild(session);
    }
  }
}
