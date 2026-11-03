import type { AgentMessage } from "../ai/types.ts";
import { CoreError } from "../errors.ts";
import type { ThinkingLevel, TodoPhase } from "../shared/mod.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import type { BackgroundCommandInfo } from "../tools/background.ts";
import type { PendingQuestion } from "../tools/ask.ts";
import type { TaskInfo } from "../shared/mod.ts";
import type { SessionAgent } from "./session-agent.ts";
import { AgentFactory } from "./factory.ts";
import type { SessionPoolDeps, SessionResources } from "./deps.ts";
export type { SessionPoolDeps, SessionResources } from "./deps.ts";

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

  /** The questions the session is still waiting on (the ask tool); empty
   * when the session is not open or nothing is pending. Restores the
   * question panel after a WS drop or page reload: `question` events are
   * never replayed, and the blocked run cannot continue without an answer. */
  getPendingQuestions(id: string): PendingQuestion[] {
    return this.sessions.get(id)?.agent?.getPendingQuestions() ?? [];
  }

  /** Build the agent of a session (replacing any existing one) and keep it
   * in memory. MCP tools attach asynchronously — they spawn server
   * processes — and errors are reported via session_error events, never
   * thrown here. */
  open(
    session: SessionInfo,
    workspace: Workspace,
    messages: AgentMessage[],
    /** The whole-transcript position `messages[0]` sits at: the agent holds
     * the model's view, not the conversation's whole history. 0 for a
     * conversation that was never compacted. */
    baseIndex = 0,
  ): SessionAgent {
    const resources: SessionResources = this.sessions.get(session.id) ?? {};
    const agent = this.factory.open(
      session,
      workspace,
      messages,
      resources,
      (attachment) => this.sessions.get(session.id)?.mcp === attachment,
      baseIndex,
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
   * started with — the level is snapshotted at run start — so this never
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
    const baseIndex = current.baseIndex;
    current.close(); // also releases the old agent's MCP servers
    this.open(session, workspace, messages, baseIndex);
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

  /** Apply an MCP config change to the listed sessions. The mutation runs
   * unconditionally: the config is the user's edit, and refusing to store it
   * because some session happens to be running would lose that edit — the
   * sessions follow the config, never the other way round. Every open
   * session is then brought onto it in the same synchronous turn: an idle
   * one is rebuilt (a fresh agent built from the new config), while a
   * streaming one cannot be (replacing its agent would duplicate the rows of
   * the run in flight, see rebuild) and has its MCP servers reconnected in
   * place instead — its run keeps the tools it started with, and the tools
   * it can discover follow the new config. */
  applyMcpConfigChange(sessions: SessionInfo[], mutate: () => void): void {
    mutate();
    for (const session of sessions) {
      const resources = this.sessions.get(session.id);
      // A session that is not open picks the config up when it is opened.
      if (resources?.agent === undefined) continue;
      if (resources.agent.isStreaming) {
        this.refreshMcpInPlace(session, resources);
        continue;
      }
      this.rebuild(session);
    }
  }

  /** Hand one streaming session its current MCP config without touching its
   * agent (see AgentFactory.refreshMcp). */
  private refreshMcpInPlace(
    session: SessionInfo,
    resources: SessionResources,
  ): void {
    this.factory.refreshMcp(
      session,
      this.deps.requireWorkspace(session.workspaceId),
      resources,
      (attachment) => this.sessions.get(session.id)?.mcp === attachment,
    );
  }

  /** Rebuild the listed sessions' MCP attachments from scratch: a fresh
   * manager reconnects every server and re-discovers its tools. Needed when
   * what changed is not the config but the credentials — an interactive
   * OAuth sign-in, which an attachment reused across agent rebuilds (and
   * its already-failed connections) would never see. Streaming sessions
   * refuse the rebuild, like every other agent replacement. */
  refreshMcp(sessions: SessionInfo[]): void {
    for (const session of sessions) {
      this.assertNotStreaming(session.id);
    }
    for (const session of sessions) {
      const resources = this.sessions.get(session.id);
      if (resources?.agent === undefined) continue;
      const previous = resources.mcp;
      // Dropping the attachment makes the factory build a new one (with a
      // fresh manager); the registries follow it, since a rebuild builds
      // fresh tools.
      resources.mcp = undefined;
      resources.registries = undefined;
      if (previous !== undefined) void previous.manager.close();
      this.rebuild(session);
    }
  }
}
