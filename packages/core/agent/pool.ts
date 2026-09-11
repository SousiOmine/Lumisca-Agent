import type { Api, Model } from "../ai/types.ts";
import type { AgentMessage, StreamFn } from "../ai/types.ts";
import { CoreError } from "../errors.ts";
import type { ThinkingLevel, TodoPhase } from "../shared/mod.ts";
import type { ClientEvent } from "../types/event.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import type { BackgroundCommandInfo } from "../tools/background.ts";
import type { BackgroundProcessManager } from "../tools/background.ts";
import type { TodoHub } from "../tools/todo.ts";
import type { TaskHub } from "../tools/task-hub.ts";
import type { TaskInfo } from "../shared/mod.ts";
import type { McpConfig } from "../mcp/config.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import type { SessionAgent } from "./session-agent.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { BrowserBackend } from "../browser/types.ts";
import { AgentFactory } from "./factory.ts";

/** Model resolution the agent factory needs (catalog + stored levels). */
export interface ModelResolver {
  /** Resolve a model or throw `not_found` (the pool's model guard shares
   * the core's "Model not found" shape). */
  requireModel(provider: string, modelId: string): Model<Api>;
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
  /** The stored thinking level of a model, clamped to what it supports. */
  getThinkingLevel(provider: string, modelId: string): ThinkingLevel;
}

/** Session persistence the agent factory needs (repos + prompt snapshot). */
export interface SessionPersistence {
  messageRepo: MessageRepo;
  /** Persist a new session title and notify clients. */
  renameSession(id: string, name: string): void;
  /** Full generated system prompt for a workspace (project memory +
   * personalization included); used only for legacy sessions that predate
   * prompt snapshots. `model` fills in the environment section.
   * `browserAvailable` gates the built-in web-browser skill in the
   * prompt's <available_skills> listing, like the snapshot path in
   * LumiscaCore.createSession. */
  buildGeneratedPrompt(
    workspace: Workspace,
    model?: { provider: string; modelId: string },
    browserAvailable?: boolean,
  ): string;
  /** Persist a rebuilt system prompt (legacy-session migration). */
  updateSystemPrompt(id: string, systemPrompt: string): void;
  /** Session-bound goal persistence (the sessions table). The pool binds
   * these to one session when building its agent; the agent's loop calls
   * them to persist progress shown in the right-side panel. */
  loadGoal(sessionId: string): import("../shared/goal.ts").GoalInfo | undefined;
  saveGoal(
    sessionId: string,
    text: string,
    maxIterations: number,
  ): import("../shared/goal.ts").GoalInfo;
  updateGoal(
    sessionId: string,
    patch: {
      iteration?: number;
      status?: import("../shared/goal.ts").GoalStatus;
      lastReason?: string | null;
    },
  ): import("../shared/goal.ts").GoalInfo | undefined;
  clearGoal(sessionId: string): string | undefined;
  requireWorkspace(id: string): Workspace;
}

/** Runtime collaborators the agent factory needs (tools + events). */
export interface AgentRuntime {
  streamFn: StreamFn;
  /** Command safety check for the session's bash/eval/async_bash tools
   * (the fast model judges commands before they run). Always present; the
   * check itself is a no-op while the feature is disabled. */
  commandSafety: CommandSafety;
  /** Merged MCP config (app-level + workspace .mcp.json + plugins) for a
   * workspace, with collected config errors. */
  loadMergedMcp(workspace: Workspace): { config: McpConfig; errors: string[] };
  /** Forward an agent event to every frontend listener. */
  emit(event: ClientEvent): void;
  /** The session's browser-lab backend (Desktop WebView host), or
   * undefined when no browser surface is available — the agent then gets
   * no browser tools. A getter so a backend attached after the pool was
   * built still reaches new agents. */
  browser?: () => BrowserBackend | undefined;
}

/** Everything the pool needs to build and manage agents, injected by
 * LumiscaCore so the pool stays free of repository wiring. Split into
 * ModelResolver / SessionPersistence / AgentRuntime so consumers depend
 * only on the slice they use. */
export type SessionPoolDeps = ModelResolver & SessionPersistence & AgentRuntime;

/** Everything one open session owns, keyed by session id. Consolidating the
 * per-session runtime state into one struct means a future resource is one
 * field here (and one clear in close/closeAll) instead of another parallel
 * map that must be kept in lockstep. */
export interface SessionResources {
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
  /** Tool registry (MCP + browser-lab tools discoverable via
   * tool_search/call), rebuilt together with the attachment when the
   * config changes. */
  registry?: ToolRegistry;
  /** The last failure of the session, if any (cleared when a new run
   * starts). Lets non-WebSocket clients learn about failures of
   * fire-and-forget prompts. */
  lastError?: string;
}

/**
 * Owns the live session agents: lifecycle (open / close / delete) and the
 * streaming guards behind configuration changes. Agent construction lives
 * in AgentFactory; the pool only keeps the map. Kept out of LumiscaCore so
 * the core stays a thin facade over the repositories.
 */
export class SessionPool {
  private readonly sessions = new Map<string, SessionResources>();
  private readonly factory: AgentFactory;

  constructor(
    private readonly deps: SessionPoolDeps,
    /** Agent construction seam (tests inject a fake; production leaves it
     * to the real factory). */
    factory?: AgentFactory,
  ) {
    this.factory = factory ?? new AgentFactory(deps);
  }

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
   * thrown here. */
  open(
    session: SessionInfo,
    workspace: Workspace,
    messages: AgentMessage[],
  ): SessionAgent {
    const resources: SessionResources = this.sessions.get(session.id) ?? {};
    const agent = this.factory.open(
      session,
      workspace,
      messages,
      resources,
      (attachment) => this.sessions.get(session.id)?.mcp === attachment,
    );
    this.sessions.set(session.id, resources);
    return agent;
  }

  /** Close a session's agent (unsubscribing from background completions),
   * stop its background commands, abort its sub-agents, tear down its MCP
   * server processes, and discard its todo plan. The persisted session
   * stays; openSession rebuilds it with fresh managers and an empty plan.
   * Await the returned promise when ordering matters (e.g. deleting the
   * workspace folder afterwards): the background kills and the MCP child
   * processes are only guaranteed dead once it resolves. */
  async close(id: string): Promise<void> {
    const resources = this.sessions.get(id);
    if (!resources) return;
    resources.agent?.close();
    resources.tasks?.close();
    this.sessions.delete(id);
    await resources.background?.killAll();
    await resources.mcp?.manager.close();
  }

  /** Close and forget a session entirely (persisted rows are deleted by
   * the caller). */
  async delete(id: string): Promise<void> {
    await this.close(id);
  }

  /** Close every agent, stop every background command, abort every
   * sub-agent, and tear down every MCP attachment (core shutdown).
   * Resolves once every background kill has taken effect and every MCP
   * child process is dead. */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    for (const resources of all) {
      resources.agent?.close();
      resources.tasks?.close();
    }
    await Promise.all(all.map((resources) => resources.background?.killAll()));
    await Promise.all(all.map((resources) => resources.mcp?.manager.close()));
  }

  /** Update the thinking level of an open session in place, without
   * rebuilding the agent. The in-flight run (if any) keeps the level it
   * started with — pi-agent-core snapshots it at run start — so this never
   * throws while streaming and never interrupts the running loop. Closed
   * sessions are ignored: their next `open()` reads the stored level. */
  setThinkingLevel(id: string, level: ThinkingLevel): void {
    this.sessions.get(id)?.agent?.setThinkingLevel(level);
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
    current.close(); // also releases the old agent's MCP servers
    this.open(session, workspace, messages);
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
