import type { AgentMessage } from "../domain/message.ts";

import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { CoreError } from "../errors.ts";
import type { TaskInfo, ThinkingLevel, TodoPhase } from "../shared/mod.ts";
import type { PendingQuestion } from "../tools/ask.ts";
import type { BackgroundCommandInfo } from "../tools/background.ts";
import type { SessionPoolDeps } from "./deps.ts";
import { AgentFactory } from "./factory.ts";
import type { SessionAgent } from "./session-agent.ts";
import type { SessionRuntime } from "./session-runtime.ts";

export type { SessionPoolDeps } from "./deps.ts";

/** What the open sessions do with a configuration change (see
 * SessionPool.applyChange). */
export type ChangePolicy = "reject" | "defer" | "inPlace";

/** Which in-place path a streaming session takes with a change it may not be
 * rebuilt for (policy `inPlace`). Each one brings the session onto the new
 * value without replacing its agent: the run keeps the tools it started
 * with, and what it can discover follows. */
export type InPlaceChange =
  /** Reseed the discoverable tools (a capability toggle). */
  | "tools"
  /** Reconnect the MCP servers against the current config. */
  | "mcp"
  /** Reconnect them because the credentials changed, not the config (a
   * sign-in). */
  | "mcp-credentials";

/** What a change finds of an open session: an idle agent it may replace, one
 * in flight it may not, or nothing at all. */
export type SessionState = "closed" | "idle" | "streaming";

/** {@link SessionState} of a runtime, as the pool asks for it. */
function stateOfRuntime(runtime: SessionRuntime): SessionState {
  if (runtime.agent === undefined) return "closed";
  return runtime.streaming ? "streaming" : "idle";
}

/** The hooks a change needs beyond its mutation and policy. */
export interface ChangeOptions {
  /** Where the caller's deferred rebuild happens (policy `defer`). */
  defer?(id: string): void;
  /** Which in-place path a streaming session takes (policy `inPlace`). */
  inPlace?: InPlaceChange;
}

/**
 * Answers what the live sessions are doing, and applies configuration changes
 * to them. Agent construction and the runtime each open session owns live in
 * AgentFactory; the pool reads a session's state through
 * AgentFactory.withRuntime and never learns what a runtime holds. Kept out of
 * LumiscaCore so the core stays a thin facade over the repositories.
 */
export class SessionPool {
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
    return this.factory.withRuntime(id, (runtime) => runtime.agent);
  }

  require(id: string): SessionAgent {
    const agent = this.get(id);
    if (!agent) {
      throw new CoreError(`Session is not open: ${id}`, "not_found");
    }
    return agent;
  }

  /** The last failure of a session, if any. Cleared when a new run starts.
   * Lets non-WebSocket clients (curl, the desktop shell) learn about
   * failures of fire-and-forget prompts instead of losing them. */
  lastError(id: string): string | undefined {
    return this.factory.withRuntime(id, (runtime) => runtime.lastError);
  }

  /** The session's current todo plan (the todo tool); empty when the
   * session is not open or has no plan yet. Lets clients restore the
   * progress panel after a WS drop or page reload — todo events are
   * snapshots, but only mutations emit them, so they are not replayed. */
  getTodo(id: string): TodoPhase[] {
    return (
      this.factory.withRuntime(id, (runtime) => runtime.todos?.getPlan()) ?? []
    );
  }

  /** Snapshots of the session's sub-agent tasks (the task tool); empty
   * when the session is not open or has no tasks yet. Restores the tasks
   * panel after a WS drop or page reload (task events are not replayed). */
  getTasks(id: string): TaskInfo[] {
    return (
      this.factory.withRuntime(id, (runtime) => runtime.tasks?.list()) ?? []
    );
  }

  /** Snapshots of the session's background commands (the async_bash tool);
   * empty when the session is not open or has no commands yet. Restores
   * the background panel after a WS drop or page reload (background events
   * are not replayed). */
  getBackground(id: string): BackgroundCommandInfo[] {
    return (
      this.factory.withRuntime(id, (runtime) => runtime.background?.list()) ??
      []
    );
  }

  /** The questions the session is still waiting on (the ask tool); empty
   * when the session is not open or nothing is pending. Restores the
   * question panel after a WS drop or page reload: `question` events are
   * never replayed, and the blocked run cannot continue without an answer. */
  getPendingQuestions(id: string): PendingQuestion[] {
    return (
      this.factory.withRuntime(id, (runtime) =>
        runtime.agent?.getPendingQuestions(),
      ) ?? []
    );
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
    return this.factory.open(session, workspace, messages, baseIndex);
  }

  /** Close a session's agent (unsubscribing from background completions),
   * stop its background commands, abort its sub-agents, tear down its MCP
   * server processes, and discard its todo plan. The persisted session
   * stays; openSession rebuilds it with fresh managers and an empty plan.
   * Await the returned promise when ordering matters (e.g. deleting the
   * workspace folder afterwards): the background kills and the MCP child
   * processes are only guaranteed dead once it resolves. */
  async close(id: string): Promise<void> {
    await this.factory.close(id);
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
    await this.factory.closeAll();
  }

  /** Update the thinking level of an open session in place, without
   * rebuilding the agent. The in-flight run (if any) keeps the level it
   * started with — the level is snapshotted at run start — so this never
   * throws while streaming and never interrupts the running loop. Closed
   * sessions are ignored: their next `open()` reads the stored level. */
  setThinkingLevel(id: string, level: ThinkingLevel): void {
    this.get(id)?.setThinkingLevel(level);
  }

  /** What an open session can take right now. A session that is not open
   * needs nothing from a change: its next `open` reads the stored value. */
  private stateOf(id: string): SessionState {
    return this.factory.withRuntime(id, stateOfRuntime) ?? "closed";
  }

  /** The shared "session is streaming" guard behind every configuration
   * change that rebuilds agents. */
  private assertNotStreaming(id: string): void {
    if (this.stateOf(id) === "streaming") {
      throw new CoreError(`Session is already running: ${id}`, "conflict");
    }
  }

  /** Rebuild the agent of an open session. The old agent is never replaced
   * while streaming: the running loop would keep executing against the
   * same message array and duplicate DB rows. */
  rebuild(session: SessionInfo): void {
    if (this.get(session.id) === undefined) return;
    this.assertNotStreaming(session.id);
    this.factory.rebuild(session);
  }

  /** Apply one configuration change to the listed sessions.
   *
   * `mutate` stores the change; `policy` says what the open sessions do with
   * it. The streaming checks and the mutation run in the same synchronous
   * turn (no awaits in between), so a prompt cannot start mid-apply. A
   * session that is not open picks the new value up when it is opened, and
   * needs nothing here.
   *
   * - `reject` refuses the whole change while any listed session streams: the
   *   setting is part of a request that is already on its way, so storing it
   *   would describe a run that is not the one in flight (a workspace folder
   *   edit). Nothing is stored unless every session can follow.
   * - `defer` stores the change unconditionally — it is the user's edit, and
   *   refusing to store it because some session happens to be running would
   *   lose that edit — then rebuilds the idle sessions at once and leaves a
   *   streaming one to the caller's `defer` (its prompt and tool set are part
   *   of the request it already sent, and replacing its agent would duplicate
   *   the rows of the run in flight).
   * - `inPlace` also stores unconditionally, and brings a streaming session
   *   onto the new value without replacing its agent (see `inPlace`).
   */
  applyChange(
    sessions: SessionInfo[],
    mutate: () => void,
    policy: ChangePolicy,
    options: ChangeOptions = {},
  ): void {
    if (policy === "reject") {
      for (const session of sessions) {
        this.assertNotStreaming(session.id);
      }
    }
    mutate();
    for (const session of sessions) {
      const state = this.stateOf(session.id);
      if (state === "closed") continue;
      if (state === "idle") {
        this.followIdle(session, options);
        continue;
      }
      // A streaming session is never rebuilt (see rebuild). `reject` refused
      // above; the guard runs again here so a write that got past it fails
      // loudly instead of leaving the session behind.
      if (policy === "reject") {
        this.assertNotStreaming(session.id);
        continue;
      }
      if (policy === "defer") {
        options.defer?.(session.id);
        continue;
      }
      this.applyInPlace(session, options.inPlace);
    }
  }

  /** What an idle session does with a change: rebuild its agent, so the next
   * run is built from the stored value. A sign-in changes no config, so the
   * attachment it holds may be the one whose connection already failed; it is
   * dropped here instead of reused by the rebuild. */
  private followIdle(session: SessionInfo, options: ChangeOptions): void {
    this.factory.rebuild(session, {
      dropMcp: options.inPlace === "mcp-credentials",
    });
  }

  /** What a streaming session does with a change it may not be rebuilt for:
   * the path `options.inPlace` names, each of which leaves the agent (and the
   * run it is executing) alone. */
  private applyInPlace(
    session: SessionInfo,
    inPlace: InPlaceChange | undefined,
  ): void {
    switch (inPlace) {
      case "tools":
        this.factory.reseedDiscoverable(
          session,
          this.deps.requireWorkspace(session.workspaceId),
        );
        return;
      case "mcp":
        this.factory.refreshMcp(
          session,
          this.deps.requireWorkspace(session.workspaceId),
        );
        return;
      case "mcp-credentials":
        this.factory.refreshMcp(
          session,
          this.deps.requireWorkspace(session.workspaceId),
          { reloadCredentials: true },
        );
        return;
      case undefined:
        throw new CoreError(
          `A change in place needs a path: ${session.id}`,
          "invalid",
        );
    }
  }
}
