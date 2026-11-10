import { Hono } from "hono";
import type { ContextUsageSummary } from "@lumisca/core/shared";
import type {
  AgentMessage,
  AskAnswer,
  BackgroundCommandInfo,
  CreateSessionInput,
  ImageContent,
  ModePrompt,
  PendingQuestion,
  PromptFileRef,
  SessionAgent,
  SessionInfo,
  TaskInfo,
  ThinkingLevel,
  TodoPhase,
  WindowQuery,
} from "@lumisca/core";
import { AppError, parseBody, parseWindowQuery } from "./util.ts";
import {
  parsePromptBody,
  preparePromptImages,
  type PromptBody,
} from "./session-requests.ts";
import { conversationRoutes } from "./conversation.ts";

/** The slice of the core these routes need (interface segregation). */
export interface SessionApi {
  getSession(id: string): SessionInfo | undefined;
  getSessionLastError(id: string): string | undefined;
  listSessions(workspaceId?: string): SessionInfo[];
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  openSession(id: string): SessionInfo;
  closeSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  getAgent(id: string): SessionAgent | undefined;
  /** One window of the session's transcript (see readTranscript): the
   * snapshot serves the newest one, and a client asks for older ones as the
   * reader scrolls up. Undefined when the session is not open. */
  readTranscript(
    id: string,
    query: WindowQuery,
  ): { items: AgentMessage[]; older: string | null } | undefined;
  /** The model a new session would get, with the thinking control data the
   * draft tab renders (matches LumiscaCore.getDefaultModel). Null when
   * none resolves — including "no provider is configured at all", which
   * the draft renders as an unset model field with the start button
   * disabled. */
  getDefaultModel(): Promise<
    {
      provider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
      thinkingLevels: ThinkingLevel[];
    } | null
  >;
  startPrompt(
    id: string,
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
    files?: PromptFileRef[],
  ): void;
  /** Write a prompt's attached files into the machine and return where they
   * are. Throws for a session that has nowhere to put them. */
  savePromptUploads(
    id: string,
    uploads: readonly { name: string; bytes: Uint8Array }[],
  ): Promise<PromptFileRef[]>;
  abort(id: string): void;
  rewind(id: string, timestamp: number): Promise<void>;
  /** Condense the session's older history into a checkpoint on demand (the
   * `/compact [instructions]` command). Resolves with the number of
   * summarized messages, or undefined when nothing could be condensed. */
  compactSession(
    id: string,
    instructions?: string,
  ): Promise<number | undefined>;
  setSessionModel(id: string, provider: string, modelId: string): void;
  /** Resolve a pending ask (the ask tool) with the user's answers. */
  answerQuestion(id: string, toolCallId: string, answers: AskAnswer[]): void;
  /** The session's current todo plan (empty when there is none). */
  getTodo(id: string): TodoPhase[];
  /** Snapshots of the session's sub-agent tasks (empty when there are none). */
  getTasks(id: string): TaskInfo[];
  /** Snapshots of the session's background commands (empty when there are
   * none). */
  getBackground(id: string): BackgroundCommandInfo[];
  /** The questions the session is still waiting on (the ask tool); empty
   * when none is pending. */
  getPendingQuestions(id: string): PendingQuestion[];
  /** The session's revision: how many events this server has emitted for
   * it (see LumiscaCore.getSessionRevision). */
  getSessionRevision(id: string): number;
  /** Context usage over the WHOLE transcript (see
   * LumiscaCore.getSessionUsage): the agent holds only the model's view, so
   * a client cannot count the older turns itself. */
  getSessionUsage(id: string): ContextUsageSummary;
}

/** The body `POST /sessions` reads. */
interface SessionBody {
  /** Omitted → a chat session ("simple chat" without a workspace). */
  workspaceId?: unknown;
  name?: unknown;
  modelProvider?: unknown;
  modelId?: unknown;
}

export function sessionRoutes(core: SessionApi): Hono {
  /** Longest custom focus a `/compact` instruction may carry. The text is
   * appended to the summarization prompt, so it is bounded like any other
   * user-facing prompt fragment. */
  const MAX_COMPACT_INSTRUCTIONS_LENGTH = 2_000;

  /** Validate the optional `/compact` instruction: a string (trimmed), an
   * empty value meaning "no instruction". Anything else — a non-string, or one
   * longer than the cap — is rejected rather than silently dropped. */
  function optionalInstructions(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
      throw new AppError("instructions must be a string", 400);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length > MAX_COMPACT_INSTRUCTIONS_LENGTH) {
      throw new AppError(
        `instructions must be at most ${MAX_COMPACT_INSTRUCTIONS_LENGTH} characters`,
        400,
      );
    }
    return trimmed;
  }

  const app = new Hono();

  /** 404 unless a session with this id exists. */
  const requireSession = (id: string) => {
    const session = core.getSession(id);
    if (!session) throw new AppError(`Session not found: ${id}`, 404);
    return session;
  };

  const sessionJson = (session: SessionInfo) => ({
    ...session,
    lastError: core.getSessionLastError(session.id),
  });

  app.get("/sessions", (c) => {
    const workspaceId = c.req.query("workspaceId");
    return c.json(core.listSessions(workspaceId));
  });

  app.get("/sessions/default-model", async (c) => {
    return c.json(await core.getDefaultModel());
  });

  app.get("/sessions/:id", (c) => {
    return c.json(sessionJson(requireSession(c.req.param("id"))));
  });

  /** The session's live-state snapshot: a window of the transcript plus
   * everything a client needs to render the session honestly after a page
   * (re)load or a WS drop (the web's tab restore and syncState).
   *
   * The transcript is a WINDOW, not the whole history: a long session's
   * transcript can be hundreds of messages, and sending all of it on every
   * reconnect, tab restore and revision probe made opening and keeping a busy
   * conversation in sync slow. `GET …/messages` serves the newest window and
   * returns `older` — the cursor for the window before it, which a client
   * echoes back to read further (see core's session/transcript-window.ts).
   * `older: null` means the transcript's beginning.
   *
   * The event stream carries no snapshot, and events are never replayed, so
   * each piece here has a client that would otherwise be shown a lie:
   * - `running`: a client that connected mid-run never saw `agent_start`,
   *   so without the flag it would present a live run as finished (work log
   *   collapsed under 作業完了);
   * - `questions`: a run blocked on the ask tool would show no way to
   *   answer it;
   * - `error`: a failure emitted while the socket was down would vanish;
   * - `name`: a title generated while the socket was down would stay stale.
   * Everything is read in this one handler, with no await between the
   * reads, so the pieces describe the same instant. */
  app.get("/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const session = requireSession(id);
    await core.openSession(id);
    const agent = core.getAgent(id);
    if (!agent) {
      // Unreachable today (openSession just created the agent), but do not
      // crash with a TypeError if that invariant ever changes.
      throw new AppError(`Session is not open: ${id}`, 404);
    }
    const page = core.readTranscript(id, parseWindowQuery(c.req.url));
    if (page === undefined) {
      throw new AppError(`Session is not open: ${id}`, 404);
    }
    const running = agent.isStreaming;
    const questions = core.getPendingQuestions(id);
    const error = core.getSessionLastError(id);
    // The revision travels with the snapshot: the client seeds its
    // "everything seen up to here" marker from it (see the web's revision
    // probe).
    const rev = core.getSessionRevision(id);
    return c.json({
      messages: page.items,
      // The way back through the history; null at its beginning.
      older: page.older,
      running,
      questions,
      error,
      name: session.name,
      // Context usage over the WHOLE transcript, not the page or the model's
      // view: the client has not loaded the older turns, so it cannot count
      // them itself, and the meter must not shrink because the reader
      // scrolled away.
      usage: core.getSessionUsage(id),
      rev,
    });
  });

  /** The session's revision: how many events this server has emitted for it
   * (see LumiscaCore.getSessionRevision). The web reads this on a low
   * interval and re-reads the snapshot only when it moved — the cheap way
   * to notice events that were emitted but never delivered (a socket that
   * died without a close event, a peer's relay gap). Deliberately does not
   * open the session: the count lives outside the agent. */
  app.get("/sessions/:id/revision", (c) => {
    const id = c.req.param("id");
    requireSession(id);
    return c.json({ rev: core.getSessionRevision(id) });
  });

  /** The session's current todo plan (the todo tool). todo events are
   * snapshots, but only mutations emit them, so clients re-fetch this
   * after a WS drop or page reload to restore the progress panel. Opens
   * the session like the messages endpoint (the plan lives in memory). */
  app.get("/sessions/:id/todo", async (c) => {
    const id = c.req.param("id");
    requireSession(id);
    await core.openSession(id);
    return c.json({ todos: core.getTodo(id) });
  });

  /** Snapshots of the session's sub-agent tasks (the task tool), for the
   * same resync as /todo: task events are not replayed, so clients
   * re-fetch after a WS drop or page reload to restore the tasks panel. */
  app.get("/sessions/:id/tasks", async (c) => {
    const id = c.req.param("id");
    requireSession(id);
    await core.openSession(id);
    return c.json({ tasks: core.getTasks(id) });
  });

  /** Snapshots of the session's background commands (the async_bash tool),
   * for the same resync as /todo: background events are not replayed, so
   * clients re-fetch after a WS drop or page reload to restore the
   * background panel. */
  app.get("/sessions/:id/background", async (c) => {
    const id = c.req.param("id");
    requireSession(id);
    await core.openSession(id);
    return c.json({ backgrounds: core.getBackground(id) });
  });

  app.post("/sessions", async (c) => {
    const body = await parseBody<SessionBody>(c);
    if (
      !body ||
      (body.workspaceId !== undefined &&
        typeof body.workspaceId !== "string")
    ) {
      throw new AppError(
        "workspaceId must be a string when given; omit it for a chat session",
        400,
      );
    }
    // Without an explicit model the core resolves the server's default one
    // (last used model of a configured provider, else its first enabled
    // model). With no provider configured at all there is no default: the
    // core refuses (503) instead of creating a session on a model that
    // could not stream. Clients show that state up front (the draft leaves
    // the model unset and disables the start button), so this is the
    // defensive layer for direct API callers.
    const session = await core.createSession({
      workspaceId: typeof body.workspaceId === "string"
        ? body.workspaceId
        : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      modelProvider: typeof body.modelProvider === "string"
        ? body.modelProvider
        : undefined,
      modelId: typeof body.modelId === "string" ? body.modelId : undefined,
    });
    return c.json(session, 201);
  });

  app.post("/sessions/:id/open", async (c) => {
    const id = c.req.param("id");
    requireSession(id);
    return c.json(sessionJson(await core.openSession(id)));
  });

  app.post("/sessions/:id/close", async (c) => {
    const id = c.req.param("id");
    requireSession(id);
    await core.closeSession(id);
    return c.json({ ok: true });
  });

  app.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    requireSession(id);
    await core.deleteSession(id);
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/prompt", async (c) => {
    const body = await parseBody<PromptBody>(c);
    const { text, images, files, mode } = parsePromptBody(body ?? {});
    const id = c.req.param("id");
    requireSession(id);
    // The pictures live in the message, so they are bounded before the
    // message is built (see preparePromptImages).
    const bounded = await preparePromptImages(images);
    // The uploads are written into the machine before the run starts, so a
    // prompt whose file could not be stored never reaches the model; that is
    // the one part of this call that is awaited. After it, the run is
    // fire-and-forget: its progress arrives on the event stream.
    const saved = files === undefined
      ? undefined
      : await core.savePromptUploads(id, files);
    core.startPrompt(id, text, bounded, mode, saved);
    return c.json({ ok: true });
  });

  // Stop, answer, rewind and a model switch are the handlers a conversation
  // shares (routes/conversation.ts): only the path and how an id is resolved
  // differ between a session and a conversation.
  conversationRoutes(app, core, {
    base: "/sessions/:id",
    resolve: (c) => requireSession(c.req.param("id")!).id,
    modelRoute: true,
  });

  /** Condense the session's older history into a checkpoint on demand (the
   * `/compact [instructions]` command). `compacted` is the number of
   * messages summarized — absent when nothing could be condensed (no safe
   * span, or the summarization failed; the transcript is unchanged in both
   * cases). The request resolves once the insertion is durable, so the
   * client can report the outcome. */
  app.post("/sessions/:id/compact", async (c) => {
    const body = await parseBody<{ instructions?: unknown }>(c);
    const id = c.req.param("id");
    requireSession(id);
    await core.openSession(id);
    const compacted = await core.compactSession(
      id,
      optionalInstructions(body?.instructions),
    );
    return c.json({ ok: true, compacted });
  });

  return app;
}
