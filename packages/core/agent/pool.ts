import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { CoreError } from "../errors.ts";
import type { ThinkingLevel } from "../shared.ts";
import type { ClientEvent } from "../types/event.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import { createCodingTools } from "../tools/mod.ts";
import { BackgroundProcessManager } from "../tools/background.ts";
import type { McpConfig } from "../mcp/config.ts";
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
  /** Persist a new session title and notify clients. */
  renameSession(id: string, name: string): void;
  /** The stored thinking level of a model, clamped to what it supports. */
  getThinkingLevel(provider: string, modelId: string): ThinkingLevel;
  /** Full generated system prompt for a workspace (project memory +
   * personalization included); used only for legacy sessions that predate
   * prompt snapshots. */
  buildGeneratedPrompt(workspace: Workspace): string;
  /** Persist a rebuilt system prompt (legacy-session migration). */
  updateSystemPrompt(id: string, systemPrompt: string): void;
  streamFn: StreamFn;
  messageRepo: MessageRepo;
  /** Merged MCP config (app-level + workspace .mcp.json + plugins) for a
   * workspace, with collected config errors. */
  loadMergedMcp(workspace: Workspace): { config: McpConfig; errors: string[] };
  requireWorkspace(id: string): Workspace;
  /** Forward an agent event to every frontend listener. */
  emit(event: ClientEvent): void;
}

/**
 * Owns the live session agents: construction, lifecycle (open / close /
 * delete), and the streaming guards behind configuration changes. Kept out
 * of LumiscaCore so the core stays a thin facade over the repositories.
 */
export class SessionPool {
  private readonly agents = new Map<string, SessionAgent>();
  /** Background-command managers, one per open session. Owned by the pool
   * (not the agent) so background commands survive agent rebuilds — model
   * and workspace changes rebuild the agent while the session stays open,
   * and the commands must keep running. They are stopped when the session
   * closes (close/delete/closeAll). */
  private readonly background = new Map<string, BackgroundProcessManager>();
  private readonly lastErrors = new Map<string, string>();

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

  /** Build the agent of a session (replacing any existing one) and keep it
   * in memory. MCP tools attach asynchronously — they spawn server
   * processes — and errors are reported via session_error events, never
   * thrown here. */
  open(
    session: SessionInfo,
    workspace: Workspace,
    messages: AgentMessage[],
  ): SessionAgent {
    const model = this.deps.getModel(session.modelProvider, session.modelId);
    if (!model) {
      throw new CoreError(
        `Model not found: ${session.modelProvider}/${session.modelId}`,
        "not_found",
      );
    }
    // Reuse the session's manager when one exists (agent rebuild); create
    // it on first open. Shared by the async_bash tools and the session
    // agent: the tools start/check/kill commands, the agent turns
    // completions into notifications. Commands die with the session (pool
    // close/delete/closeAll → killAll), not with the agent.
    let background = this.background.get(session.id);
    if (!background) {
      background = new BackgroundProcessManager();
      this.background.set(session.id, background);
    }
    const tools = createCodingTools(workspace, { background });
    // The system prompt is a per-session snapshot taken at creation
    // (custom prompts are stored verbatim). Only legacy sessions without a
    // stored prompt (created before snapshots) rebuild once — and the
    // rebuilt prompt is persisted right away so subsequent opens stay
    // frozen against AGENTS.md edits.
    let systemPrompt = session.systemPrompt;
    if (systemPrompt === undefined) {
      systemPrompt = this.deps.buildGeneratedPrompt(workspace);
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
      imageAnalysisModel: this.deps.getImageAnalysisModel(),
      fastModel: this.deps.getFastModel(),
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
    const mcp = this.deps.loadMergedMcp(workspace);
    void agent.attachMcpTools(
      mcp.config,
      mcp.errors,
      workspace.folders[0] ?? Deno.cwd(),
    );
    this.agents.set(session.id, agent);
    return agent;
  }

  /** Close a session's agent (releasing its MCP servers and unsubscribing
   * from background completions) and stop its background commands. The
   * persisted session stays; openSession rebuilds it with a fresh manager. */
  close(id: string): void {
    this.agents.get(id)?.close();
    this.agents.delete(id);
    this.background.get(id)?.killAll();
    this.background.delete(id);
  }

  /** Close and forget a session entirely (persisted rows are deleted by
   * the caller). */
  delete(id: string): void {
    this.close(id);
    this.lastErrors.delete(id);
  }

  /** Close every agent and stop every background command (core shutdown). */
  closeAll(): void {
    for (const agent of this.agents.values()) {
      agent.close();
    }
    for (const manager of this.background.values()) {
      manager.killAll();
    }
    this.agents.clear();
    this.background.clear();
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
      current.close(); // also releases the old agent's MCP servers
      this.agents.delete(session.id);
      this.agents.set(session.id, this.open(session, workspace, messages));
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
