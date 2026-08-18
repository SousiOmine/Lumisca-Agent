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
}

/** True when two merged configs describe the same servers (the merge keeps
 * a stable insertion order). A rebuild with an unchanged config reuses the
 * session's MCP attachment — and its server processes — instead of
 * respawning them. */
function sameMcpConfig(a: McpConfig, b: McpConfig): boolean {
  return JSON.stringify(a.servers) === JSON.stringify(b.servers);
}

/**
 * Owns the live session agents: construction, lifecycle (open / close /
 * delete), and the streaming guards behind configuration changes. Kept out
 * of LumiscaCore so the core stays a thin facade over the repositories.
 */
export class SessionPool {
  private readonly agents = new Map<
    string,
    SessionAgent
  >(); /** Background-command managers, one per open session. Owned by the pool
   * (not the agent) so background commands survive agent rebuilds — model
   * and workspace changes rebuild the agent while the session stays open,
   * and the commands must keep running. They are stopped when the session
   * closes (close/delete/closeAll). */

  private readonly background = new Map<string, BackgroundProcessManager>();
  /** Todo hubs, one per open session. Owned by the pool (not the agent) so
   * the plan survives agent rebuilds — the same reason as `background`.
   * Discarded when the session closes (close/delete/closeAll). */
  private readonly todos = new Map<string, TodoHub>();
  /** Task hubs, one per open session. Owned by the pool (not the agent) so
   * sub-agents survive agent rebuilds — they run independently of the agent
   * run, like background commands. All sub-agents are aborted when the
   * session closes (close/delete/closeAll). */
  private readonly tasks = new Map<string, TaskHub>();
  /** Shared MCP attachments, one per open session. Owned by the pool (not
   * the agent) so the server processes serve every agent of the session —
   * the main agent and the sub-agents — and survive agent rebuilds while
   * the merged config is unchanged. Closed when the session closes
   * (close/delete/closeAll). */
  private readonly mcp = new Map<string, McpAttachment>();
  /** Tool registries, one per open session, with the same lifecycle as the
   * MCP attachment: rebuilt together with it on config changes, discarded
   * on close. Holds every tool that is discoverable through tool_search
   * instead of being preloaded into the LLM context (MCP tools today,
   * future extension tools via addTools). */
  private readonly registries = new Map<string, ToolRegistry>();
  private readonly lastErrors = new Map<string, string>();
  /** Sessions currently open with `headless: true` (the CLI `run` path).
   * The flag is not persisted, but it must survive agent rebuilds (model
   * / thinking-level / MCP / workspace changes) — a rebuild re-opens the
   * agent and would otherwise lose the auto-answer behavior. Updated on
   * every open() call (a normal reopen clears it) and on close. */
  private readonly headlessSessions = new Set<string>();

  constructor(private readonly deps: SessionPoolDeps) {}

  get(id: string): SessionAgent | undefined {
    return this.agents.get(id);
  }

  require(id: string): SessionAgent {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new CoreError(`Session is not open: ${id}`, "not_found");
    }
    return agent;
  }

  /** The last failure of a session, if any. Cleared when a new run starts.
   * Lets non-WebSocket clients (curl, the desktop shell) learn about
   * failures of fire-and-forget prompts instead of losing them. */
  lastError(id: string): string | undefined {
    return this.lastErrors.get(id);
  }

  /** The session's current todo plan (the todo tool); empty when the
   * session is not open or has no plan yet. Lets clients restore the
   * progress panel after a WS drop or page reload — todo events are
   * snapshots, but only mutations emit them, so they are not replayed. */
  getTodo(id: string): TodoPhase[] {
    return this.todos.get(id)?.getPlan() ?? [];
  }

  /** Snapshots of the session's sub-agent tasks (the task tool); empty
   * when the session is not open or has no tasks yet. Restores the tasks
   * panel after a WS drop or page reload (task events are not replayed). */
  getTasks(id: string): TaskInfo[] {
    return this.tasks.get(id)?.list() ?? [];
  }

  /** Snapshots of the session's background commands (the async_bash tool);
   * empty when the session is not open or has no commands yet. Restores
   * the background panel after a WS drop or page reload (background events
   * are not replayed). */
  getBackground(id: string): BackgroundCommandInfo[] {
    return this.background.get(id)?.list() ?? [];
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
    // Track the headless flag per session (see headlessSessions): it is a
    // runtime property of the open agent, so an explicit headless open
    // records it and a plain reopen (openSession) clears it.
    if (options.headless) {
      this.headlessSessions.add(session.id);
    } else {
      this.headlessSessions.delete(session.id);
    }
    const model = this.deps.getModel(session.modelProvider, session.modelId);
    if (!model) {
      throw new CoreError(
        `Model not found: ${session.modelProvider}/${session.modelId}`,
        "not_found",
      );
    }
    // One shared MCP attachment per session: its server processes serve
    // every agent of the session (the main agent and the sub-agents) and
    // survive agent rebuilds while the merged config is unchanged. A
    // changed config rebuilds the attachment and tears down the old
    // processes. Config errors and failed servers are reported once per
    // attachment, so a rebuild must not re-report them.
    const mergedMcp = this.deps.loadMergedMcp(workspace);
    let mcp = this.mcp.get(session.id);
    if (mcp === undefined || !sameMcpConfig(mcp.config, mergedMcp.config)) {
      const previous = mcp;
      mcp = new McpAttachment(
        new McpManager(mergedMcp.config, workspace.folders[0] ?? Deno.cwd()),
        mergedMcp.config,
      );
      this.mcp.set(session.id, mcp);
      // A config change builds fresh tools, so the registry is rebuilt
      // with the attachment — stale tools must not survive it. A rebuild
      // with an unchanged config reuses both.
      this.registries.set(session.id, new ToolRegistry());
      if (previous !== undefined) void previous.manager.close();
      const emitError = (message: string) => {
        this.lastErrors.set(session.id, message);
        this.deps.emit({
          type: "session_error",
          sessionId: session.id,
          message,
        });
      };
      for (const message of mergedMcp.errors) emitError(message);
      const attachment = mcp;
      void attachment.ready.then(() => {
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
    const registry = this.registries.get(session.id)!;
    // Reuse the session's manager when one exists (agent rebuild); create
    // it on first open. Shared by the async_bash tools and the session
    // agent: the tools start/check/kill commands, the agent turns
    // completions into notifications. Commands die with the session (pool
    // close/delete/closeAll → killAll), not with the agent.
    let background = this.background.get(session.id);
    if (!background) {
      background = new BackgroundProcessManager({
        sessionId: session.id,
        emit: (event) => this.deps.emit(event),
      });
      this.background.set(session.id, background);
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
    let todo = this.todos.get(session.id);
    if (!todo) {
      todo = new TodoHub(session.id, (event) => this.deps.emit(event));
      this.todos.set(session.id, todo);
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
    let tasks = this.tasks.get(session.id);
    if (!tasks) {
      tasks = new TaskHub({
        sessionId: session.id,
        resolveRuntime: runtimeResolver,
        streamFn: this.deps.streamFn,
        safety: this.deps.commandSafety,
        emit: (event: ClientEvent) => this.deps.emit(event),
      });
      this.tasks.set(session.id, tasks);
    } else {
      tasks.setRuntimeResolver(runtimeResolver);
    }
    // The sub-agents share the session's MCP attachment (general
    // sub-agents get the search/call tools over its registry).
    tasks.setMcp(mcp, registry);
    const tools = createCodingTools(workspace, {
      background,
      ask: askHub,
      todo,
      task: tasks,
      safety: this.deps.commandSafety,
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
          this.lastErrors.set(event.sessionId, event.message);
        } else if (event.type === "agent_start") {
          this.lastErrors.delete(event.sessionId);
        }
        this.deps.emit(event);
      },
    });
    agent.attachMcp(mcp);
    this.agents.set(session.id, agent);
    return agent;
  }

  /** Close a session's agent (unsubscribing from background completions),
   * stop its background commands, abort its sub-agents, tear down its MCP
   * server processes, and discard its todo plan. The persisted session
   * stays; openSession rebuilds it with fresh managers and an empty plan. */
  close(id: string): void {
    this.agents.get(id)?.close();
    this.agents.delete(id);
    this.background.get(id)?.killAll();
    this.background.delete(id);
    this.todos.delete(id);
    this.tasks.get(id)?.close();
    this.tasks.delete(id);
    this.headlessSessions.delete(id);
    void this.mcp.get(id)?.manager.close();
    this.mcp.delete(id);
    this.registries.delete(id);
  }

  /** Close and forget a session entirely (persisted rows are deleted by
   * the caller). */
  delete(id: string): void {
    this.close(id);
    this.lastErrors.delete(id);
  }

  /** Close every agent, stop every background command, abort every
   * sub-agent, and tear down every MCP attachment (core shutdown). */
  closeAll(): void {
    for (const agent of this.agents.values()) {
      agent.close();
    }
    for (const manager of this.background.values()) {
      manager.killAll();
    }
    for (const tasks of this.tasks.values()) {
      tasks.close();
    }
    for (const mcp of this.mcp.values()) {
      void mcp.manager.close();
    }
    this.agents.clear();
    this.background.clear();
    this.todos.clear();
    this.tasks.clear();
    this.mcp.clear();
    this.registries.clear();
    this.headlessSessions.clear();
    this.lastErrors.clear();
  }

  /** Rebuild the agent of an open session. The old agent is never replaced
   * while streaming: the running loop would keep executing against the
   * same message array and duplicate DB rows. */
  rebuild(session: SessionInfo): void {
    const workspace = this.deps.requireWorkspace(session.workspaceId);
    const current = this.agents.get(session.id);
    if (current) {
      if (current.isStreaming) {
        throw new CoreError(
          `Session is already running: ${session.id}`,
          "conflict",
        );
      }
      const messages = current.messages;
      const headless = this.headlessSessions.has(session.id);
      current.close(); // also releases the old agent's MCP servers
      this.agents.delete(session.id);
      this.agents.set(
        session.id,
        this.open(session, workspace, messages, { headless }),
      );
    }
  }

  /** Refuse configuration changes while any listed session is streaming,
   * apply the mutation, then rebuild every affected agent. */
  applyChange(sessions: SessionInfo[], mutate: () => void): void {
    for (const session of sessions) {
      if (this.agents.get(session.id)?.isStreaming) {
        throw new CoreError(
          `Session is already running: ${session.id}`,
          "conflict",
        );
      }
    }
    mutate();
    for (const session of sessions) {
      this.rebuild(session);
    }
  }
}
