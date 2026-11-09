import { CoreError } from "../errors.ts";
import { formatSessionName, type ThinkingLevel } from "../shared/mod.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { SessionServiceDeps } from "./session-deps.ts";

/** The default model a new session gets, with the thinking control data the
 * draft tab renders. Null when none resolves (including "no provider is
 * configured at all"). */
export interface DefaultModel {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
}

/** What a new session is created from. */
export interface CreateSessionInput {
  /** The session's workspace; omitted → a chat session in the folder-less
   * chat workspace ("simple chat" without a workspace picker). */
  workspaceId?: string;
  name?: string;
  /** Omitted → the last-used model (or the first enabled model) is used. */
  modelProvider?: string;
  modelId?: string;
}

type Deps = Pick<
  SessionServiceDeps,
  | "sessions"
  | "pool"
  | "messages"
  | "visuals"
  | "attachments"
  | "models"
  | "requireWorkspace"
  | "chatWorkspace"
  | "resolveDefaultModel"
  | "decorate"
  | "forget"
  | "emit"
  | "language"
>;

/**
 * A session's life: creating it, opening and closing its agent, deleting it,
 * and the model and name it carries.
 *
 * The row is the truth; the pool holds the live agent. Every method here
 * either writes the row and lets the next open follow it, or changes the
 * agent that is already open. The two must agree, which is why they live
 * together.
 */
export class SessionLifecycle {
  /** Sessions whose model change arrived while a run was in flight: their
   * agent is rebuilt as that run ends (see releasePendingRebuild). */
  private readonly pendingModelRebuilds = new Set<string>();

  constructor(private readonly deps: Deps) {}

  /** The model a new session would get. */
  async getDefaultModel(): Promise<DefaultModel | null> {
    try {
      const model = await this.deps.resolveDefaultModel();
      return {
        ...model,
        ...this.deps.models.thinkingState(
          model.provider,
          model.modelId,
          this.deps.models.getModel(model.provider, model.modelId),
        ),
      };
    } catch {
      return null;
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    // No workspaceId → a chat session in the folder-less chat workspace
    // (created on first use).
    const workspace = input.workspaceId !== undefined
      ? this.deps.requireWorkspace(input.workspaceId)
      : this.deps.chatWorkspace();
    const model = await this.deps.resolveDefaultModel(
      input.modelProvider,
      input.modelId,
    );
    // The system prompt is generated (and persisted) when the session is
    // opened below: it depends on the tool set the session actually gets,
    // which only the agent factory knows.
    const session = this.deps.sessions.create({
      workspaceId: workspace.id,
      // The provisional name is replaced by the title generator right after
      // the first message; it is stored, so it keeps the language it was
      // created with.
      name: input.name ?? formatSessionName(this.deps.language()),
      modelProvider: model.provider,
      modelId: model.modelId,
    });
    this.deps.pool.open(session, workspace, []);
    // The event carries the decorated session (chat flag etc.), the same
    // shape every other SessionInfo consumer sees — never the raw row.
    // Re-read it: opening generated and persisted the system prompt.
    const decorated = this.deps.decorate(
      this.deps.sessions.get(session.id) ?? session,
    );
    this.deps.emit({ type: "session_created", session: decorated });
    return decorated;
  }

  listSessions(workspaceId?: string): SessionInfo[] {
    return this.deps.sessions.list(workspaceId).map((s) =>
      this.deps.decorate(s)
    );
  }

  getSession(id: string): SessionInfo | undefined {
    const session = this.deps.sessions.get(id);
    return session ? this.deps.decorate(session) : undefined;
  }

  /** The conversation a stella agent already has, or undefined before its
   * first open. The client addresses a conversation by agent (stella has no
   * session concept), so this is the lookup that needs no session id. */
  findStellaSession(agentId: string): SessionInfo | undefined {
    const session = this.deps.sessions.getByAgent(agentId);
    return session === undefined ? undefined : this.deps.decorate(session);
  }

  /** Open a session (idempotent): build its agent if it has none. */
  openSession(id: string): SessionInfo {
    const session = this.deps.sessions.get(id);
    if (!session) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    if (!this.deps.pool.get(id)) {
      const workspace = this.deps.requireWorkspace(session.workspaceId);
      const view = this.modelViewOf(id);
      this.deps.pool.open(session, workspace, view.messages, view.baseIndex);
    }
    return this.deps.decorate(session);
  }

  async closeSession(id: string): Promise<void> {
    await this.deps.pool.close(id);
    // A change that was waiting for a run has nothing left to apply: the row
    // already carries it, and the next open reads the row.
    this.pendingModelRebuilds.delete(id);
    // The session's in-memory state (and with it the revision count) is
    // gone: a client still holding the old count sees a difference and
    // re-reads the snapshot — the right reaction, since the reopened agent
    // starts from what was persisted.
    this.deps.forget(id);
  }

  async deleteSession(id: string): Promise<void> {
    // Start the teardown first (its synchronous prefix runs inline), then
    // drop the persisted row synchronously so the session is synchronously
    // gone for callers that do not await.
    const closing = this.deps.pool.delete(id);
    this.pendingModelRebuilds.delete(id);
    this.deps.sessions.delete(id);
    this.deps.forget(id);
    await closing;
    // The published visuals and the files the agent sent belong to the
    // session: once it is gone nothing can reference them (a message that
    // did is gone too).
    await this.deps.visuals.deleteSession(id);
    await this.deps.attachments.deleteSession(id);
  }

  /**
   * Switch the model used by a session (persisted).
   *
   * The row is written at once, so a session that is not open — or a server
   * that restarts before the next run — opens on the new model. An open,
   * idle agent is rebuilt in the same call.
   *
   * A run in flight keeps the model it started with and the change is applied
   * as that run ends ({@link releasePendingRebuild}). Refusing instead would
   * answer "no" to a request that has nothing to do with the run, and
   * rebuilding now would replace the agent under a loop that is still
   * executing (and duplicate the rows of the run in flight).
   */
  setSessionModel(id: string, provider: string, modelId: string): void {
    const session = this.deps.sessions.get(id);
    if (!session) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    if (this.deps.models.getModel(provider, modelId) === undefined) {
      throw new CoreError(
        `Model not found: ${provider}/${modelId}`,
        "not_found",
      );
    }
    this.deps.sessions.updateModel(id, provider, modelId);
    const updated = { ...session, modelProvider: provider, modelId };
    const agent = this.deps.pool.get(id);
    // Closed: the next open builds from the row that was just written.
    if (agent === undefined) return;
    if (agent.isStreaming) {
      this.pendingModelRebuilds.add(id);
      return;
    }
    this.deps.pool.rebuild(updated);
  }

  /**
   * The run of `id` has ended: rebuild its agent if a model change waited for
   * it.
   *
   * Deferred by a microtask because the caller is the `agent_end` event, which
   * the running agent emits from its own teardown; rebuilding closes that
   * agent, so it happens after the emission has returned.
   */
  releasePendingRebuild(id: string): void {
    if (!this.pendingModelRebuilds.delete(id)) return;
    queueMicrotask(() => {
      // Re-read the row: the choice the user settled on, not the one that
      // was pending when a run started.
      const session = this.deps.sessions.get(id);
      if (session === undefined) return;
      if (this.deps.pool.get(id)?.isStreaming) {
        // Another run started first; its end releases this one.
        this.pendingModelRebuilds.add(id);
        return;
      }
      this.deps.pool.rebuild(session);
    });
  }

  /** Rename a session (persisted) and notify clients. */
  setSessionName(id: string, name: string): void {
    this.deps.sessions.rename(id, name);
    this.deps.emit({ type: "session_renamed", sessionId: id, name });
  }

  /** The thinking level stored for a model. */
  getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel {
    return this.deps.models.getThinkingLevel(provider, modelId);
  }

  /** The messages the model is shown: from the newest checkpoint on, with
   * the whole-transcript position they start at. */
  private modelViewOf(id: string): {
    messages: import("../ai/types.ts").AgentMessage[];
    baseIndex: number;
  } {
    const rows = this.deps.messages.listModelView(id);
    return {
      messages: rows.map((row) => row.message),
      baseIndex: this.deps.messages.count(id, "all") - rows.length,
    };
  }
}
