import { extname } from "node:path";
import type { AgentMessage } from "../ai/types.ts";
import type { Api, Model } from "../ai/types.ts";
import type { SessionAgent } from "../agent/session-agent.ts";
import type { SessionPool } from "../agent/pool.ts";
import { stellaEntryCursorOf, stellaEntryOf } from "../agent/stella-stream.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import type { ClientEvent } from "../types/event.ts";
import type { ContextUsageSummary, Locale } from "../shared/mod.ts";
import { formatSessionName } from "../shared/mod.ts";
import type {
  AskAnswer,
  GoalInfo,
  PromptFileRef,
  TaskInfo,
  ThinkingLevel,
  TodoPhase,
} from "../shared/mod.ts";
import { RASTER_IMAGE_MIME_BY_EXTENSION } from "../shared/mod.ts";
import type { BackgroundCommandInfo } from "../tools/background.ts";
import type { PendingQuestion } from "../tools/ask.ts";
import type { ModePrompt } from "../types/mode-message.ts";
import type { ImageContent } from "../ai/types.ts";
import type { StellaEntry } from "../types/stella-conversation.ts";
import type { SessionRepo } from "../session/repo.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { SessionVisualStore } from "../session/visuals.ts";
import type { SessionAttachmentStore } from "../session/attachments.ts";
import {
  messageCursorOf,
  startsTranscriptTurn,
  type WindowPage,
  type WindowQuery,
} from "../session/transcript-window.ts";
import { readTranscriptPage } from "../session/transcript-pager.ts";

/** The conversation entries a set of stored rows projects to, oldest
 * first — one projection shared by the window reader and `history_search`. */
function entriesOf(messages: readonly AgentMessage[]): StellaEntry[] {
  const entries: StellaEntry[] = [];
  for (const message of messages) {
    const entry = stellaEntryOf(message);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}
import { summarizeContextUsage } from "../shared/context-usage.ts";
import { sessionSkills } from "../tools/toolsets.ts";
import { skillInfo } from "../skills/discover.ts";
import type { SkillDef, SkillInfo } from "../skills/discover.ts";
import { CoreError } from "../errors.ts";
import {
  MAX_PROMPT_IMAGE_BYTES,
  readUpload,
  saveUploads,
  type UploadFile,
} from "../vm/uploads.ts";
import type { StellaMachine } from "../vm/machine.ts";

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

/**
 * The sessions an installation owns: creating, opening, reading and
 * steering them, and the assets they publish.
 *
 * Extracted from LumiscaCore (which kept 570 lines of it). The class owns
 * the orchestration — which collaborator answers a question — while the
 * agent runtime, the message store and the asset stores stay where they
 * were; everything it needs is injected below, so a test can drive it with
 * the same fakes the pool takes.
 *
 * Two things are deliberately NOT here: `decorateSession` stays with the
 * facade because every consumer of a SessionInfo goes through it (the event
 * emitter included), and the model resolution is injected so this class
 * does not have to know whether a model came from settings or a catalog.
 */
export class SessionCatalog {
  constructor(
    private readonly deps: {
      sessions: SessionRepo;
      messages: MessageRepo;
      pool: SessionPool;
      visuals: SessionVisualStore;
      attachments: SessionAttachmentStore;
      stella: StellaMachine;
      models: {
        getModel(provider: string, modelId: string): Model<Api> | undefined;
        getSessionModel(
          provider: string,
          modelId: string,
        ): Model<Api> | undefined;
        thinkingState(
          provider: string,
          modelId: string,
          model: Model<Api> | undefined,
        ): { thinkingLevel: ThinkingLevel; thinkingLevels: ThinkingLevel[] };
        getThinkingLevel(provider: string, modelId: string): ThinkingLevel;
      };
      /** The agent's model, allowing a retired one (see
       * ModelManager.getModelWithRetired). */
      requireModel(provider: string, modelId: string): Model<Api>;
      requireWorkspace(id: string): Workspace;
      chatWorkspace(): Workspace;
      resolveDefaultModel(
        provider?: string,
        modelId?: string,
      ): Promise<{ provider: string; modelId: string }>;
      decorate(session: SessionInfo): SessionInfo;
      /** Publish an event to every frontend listener. */
      emit(event: ClientEvent): void;
      /** Drop the in-memory state of a session (revisions, handover hubs). */
      forget(sessionId: string): void;
      language(): Locale;
      browserAvailable(): boolean;
      computerAvailable(): boolean;
      globalSkillDirs: string[] | undefined;
      /** Every session's stella skill catalog as last read. */
      stellaSkills(): SkillDef[];
    },
  ) {}

  // --- creating and listing ------------------------------------------------

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

  // --- opening and closing -------------------------------------------------

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
    this.deps.sessions.delete(id);
    this.deps.forget(id);
    await closing;
    // The published visuals and the files the agent sent belong to the
    // session: once it is gone nothing can reference them (a message that
    // did is gone too).
    await this.deps.visuals.deleteSession(id);
    await this.deps.attachments.deleteSession(id);
  }

  // --- reading a session's state ------------------------------------------

  getAgent(id: string): SessionAgent | undefined {
    return this.deps.pool.get(id);
  }

  getTodo(id: string): TodoPhase[] {
    return this.deps.pool.getTodo(id);
  }

  getTasks(id: string): TaskInfo[] {
    return this.deps.pool.getTasks(id);
  }

  getBackground(id: string): BackgroundCommandInfo[] {
    return this.deps.pool.getBackground(id);
  }

  getPendingQuestions(id: string): PendingQuestion[] {
    return this.deps.pool.getPendingQuestions(id);
  }

  getGoal(id: string): GoalInfo | undefined {
    return this.deps.sessions.getGoal(id);
  }

  cancelGoal(id: string): void {
    this.deps.pool.require(id).cancelGoal();
    this.deps.sessions.touch(id);
  }

  getSessionLastError(id: string): string | undefined {
    return this.deps.pool.lastError(id);
  }

  /** The skills a session in this workspace would get (the same discovery
   * the agent's skill tool and the catalog provider run). */
  listSkills(workspaceId?: string): SkillInfo[] {
    const folders = workspaceId === undefined
      ? []
      : this.deps.requireWorkspace(workspaceId).folders;
    return sessionSkills(folders, {
      browserAvailable: this.deps.browserAvailable(),
      computerAvailable: this.deps.computerAvailable(),
      // The palette lists what this workspace's main agent can load.
      mcpAdmin: true,
      globalDirs: this.deps.globalSkillDirs,
    }).map(skillInfo);
  }

  /** The stella conversation's skill catalog: what its agent can actually
   * load (the machine's own skills, the user's global set, the built-ins). */
  listStellaSkills(): SkillInfo[] {
    return this.deps.stellaSkills().map(skillInfo);
  }

  /** The file one of a session's published visuals names. */
  resolveSessionVisual(
    sessionId: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    return this.deps.visuals.resolve(sessionId, name);
  }

  /** The file one of a session's attachments names. */
  resolveSessionAttachment(
    sessionId: string,
    name: string,
  ): Promise<
    { path: string; mimeType: string; downloadName: string } | undefined
  > {
    return this.deps.attachments.resolve(sessionId, name);
  }

  /** One window of a session's transcript, read from the store. */
  readTranscript(
    id: string,
    query: WindowQuery,
  ): WindowPage<AgentMessage> | undefined {
    if (this.deps.pool.get(id) === undefined) return undefined;
    const page = readTranscriptPage(this.deps.messages, id, query, {
      startsWindow: (message) => startsTranscriptTurn(message),
      rows: "all",
      project: (row) => ({
        item: row.message,
        cursor: messageCursorOf(row.message),
      }),
    });
    return (query.older ?? null) === null ? this.withLiveTail(id, page) : page;
  }

  /** One window of a stella conversation, in the shape its client draws. */
  readStellaConversation(
    id: string,
    query: WindowQuery,
  ): WindowPage<StellaEntry> | undefined {
    if (this.deps.pool.get(id) === undefined) return undefined;
    // Project first, page over the projection: a page must count what the
    // conversation shows, not what the model's history holds (most of a
    // stella transcript is tool traffic nobody sees). `rows:
    // "conversation"` is what makes the page a count of those entries —
    // without it a page of 40 filled up on tool rows during a run and
    // projected to nothing.
    const page = readTranscriptPage(this.deps.messages, id, query, {
      startsWindow: () => true,
      rows: "conversation",
      project: (row) => {
        const entry = stellaEntryOf(row.message);
        return entry === null
          ? undefined
          : { item: entry, cursor: stellaEntryCursorOf(entry) };
      },
    });
    if ((query.older ?? null) !== null) return page;
    // The prompt of a run in flight is not written yet; a conversation read
    // mid-run must still show it (see unpersistedTail).
    const tail = entriesOf(this.unpersistedTail(id));
    return tail.length === 0
      ? page
      : { items: page.items.concat(tail), older: page.older };
  }

  /** The session's context usage over the WHOLE transcript. */
  getSessionUsage(id: string): ContextUsageSummary {
    return summarizeContextUsage(this.deps.messages.usageRows(id));
  }

  // --- prompting ----------------------------------------------------------

  /** Put a prompt's attached files into the machine. */
  async savePromptUploads(
    id: string,
    uploads: readonly UploadFile[],
  ): Promise<PromptFileRef[]> {
    const session = this.deps.sessions.get(id);
    if (session === undefined) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    if (session.stella !== true || session.agentId === undefined) {
      throw new CoreError(
        "Attached files can only be sent to a stella conversation: this " +
          "session's tools work on the user's own folders, so there is " +
          "nowhere to put them",
        "invalid",
      );
    }
    const exec = this.deps.stella.exec();
    if (exec === undefined) {
      throw new CoreError(
        "The machine is not available, so the files cannot be put in it",
        "unavailable",
      );
    }
    return await saveUploads(uploads, { exec, agentId: session.agentId });
  }

  /** Read one file a prompt brought back out of the machine. */
  async resolvePromptUpload(
    agentId: string,
    ref: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
    const exec = this.deps.stella.exec();
    const execBytes = this.deps.stella.execBytes();
    if (exec === undefined || execBytes === undefined) {
      throw new CoreError(
        "The machine is not available, so the file cannot be read",
        "unavailable",
      );
    }
    const read = await readUpload(exec, execBytes, {
      agentId,
      ref,
      maxBytes: MAX_PROMPT_IMAGE_BYTES,
    });
    if (read === undefined) return undefined;
    // The type comes from the extension the store chose, not from the bytes:
    // the name is what the store generated, and a prompt picture was stored
    // under its own type's extension (see the prompt route).
    const extension = extname(read.name).toLowerCase();
    const mimeType = RASTER_IMAGE_MIME_BY_EXTENSION[extension] ??
      "application/octet-stream";
    return { bytes: read.bytes, mimeType };
  }

  /** Send a prompt into a session (fire-and-forget). */
  startPrompt(
    id: string,
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
    files?: PromptFileRef[],
  ): void {
    const agent = this.deps.pool.require(id);
    this.deps.sessions.touch(id);
    agent.promptWhileRunning(text, images, mode, undefined, files);
  }

  abort(id: string): void {
    this.deps.pool.require(id).abort();
  }

  answerQuestion(id: string, toolCallId: string, answers: AskAnswer[]): void {
    this.deps.pool.require(id).answerQuestion(toolCallId, answers);
  }

  /** Undo the transcript from a user message onward. */
  async rewind(id: string, timestamp: number): Promise<void> {
    const agent = this.deps.pool.require(id);
    this.deps.sessions.touch(id);
    await agent.rewind(timestamp);
  }

  /** Condense the session's older history into a checkpoint on demand. */
  async compactSession(
    id: string,
    instructions?: string,
  ): Promise<number | undefined> {
    const agent = this.deps.pool.require(id);
    this.deps.sessions.touch(id);
    const result = await agent.compactNow(instructions);
    return result?.summarized.length;
  }

  /** Switch the model used by a session (persisted). */
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
    this.deps.pool.applyChange(
      [{ ...session, modelProvider: provider, modelId }],
      () => {
        this.deps.sessions.updateModel(id, provider, modelId);
      },
    );
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

  // --- internals ----------------------------------------------------------

  /** The messages the model is shown: from the newest checkpoint on, with
   * the whole-transcript position they start at. */
  private modelViewOf(id: string): {
    messages: AgentMessage[];
    baseIndex: number;
  } {
    const rows = this.deps.messages.listModelView(id);
    return {
      messages: rows.map((row) => row.message),
      baseIndex: this.deps.messages.count(id, "all") - rows.length,
    };
  }

  /** Append the rows a run has appended but not yet written. */
  private withLiveTail(
    id: string,
    page: WindowPage<AgentMessage>,
  ): WindowPage<AgentMessage> {
    const tail = this.unpersistedTail(id);
    return tail.length === 0
      ? page
      : { items: page.items.concat(tail), older: page.older };
  }

  /** The rows of one session the store does NOT hold yet. */
  private unpersistedTail(id: string): AgentMessage[] {
    const agent = this.deps.pool.get(id);
    if (agent === undefined) return [];
    const view = agent.messages;
    const count = agent.persistedCount;
    return count >= view.length ? [] : view.slice(count);
  }
}
