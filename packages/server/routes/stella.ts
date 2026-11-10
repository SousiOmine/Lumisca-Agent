import { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type {
  AskAnswer,
  ClientEvent,
  PromptFileRef,
  SessionInfo,
  StellaAgent,
  StellaAgentSummary,
  StellaConversationSnapshot,
  StellaEntry,
  StellaHandover,
  StellaQuestion,
  WindowQuery,
} from "@lumisca/core";
import type {
  StellaAvailability,
  StellaStatus,
  ThinkingLevel,
} from "@lumisca/core/shared";
import { base64ToBytes, stellaEventsOf } from "@lumisca/core";
import {
  AGENT_ICON_FORMATS,
  agentIconExtensionOfMimeType,
  MAX_AGENT_ICON_BYTES,
  rasterExtensionOfMimeType,
} from "@lumisca/core/shared";
import {
  AppError,
  optionalString,
  parseBody,
  parseWindowQuery,
  requireNonEmptyString,
} from "./util.ts";
import {
  parsePromptBody,
  preparePromptImages,
  type PromptBody,
} from "./session-requests.ts";
import { conversationRoutes } from "./conversation.ts";
import { createEventStream } from "./ws-stream.ts";

/** The slice of the core these routes need (interface segregation). */
export interface StellaApi {
  /** The sidebar's rows: the agents with what their conversation last said
   * (see shared/stella-preview.ts). The list exists for this route only, so
   * it is the summary shape that is declared here. */
  listStellaAgentSummaries(): StellaAgentSummary[];
  /** Create the starter agent a fresh installation talks to, unless one
   * already exists. Returns the agent a client opens. */
  ensureStellaAgent(): Promise<StellaAgent>;
  /** Create an agent: its row, and its working folder with MEMORY.md in it
   * when the machine is up (see LumiscaCore.createStellaAgent). */
  createStellaAgent(
    input: { name: string; role: string },
  ): Promise<StellaAgent>;
  /** Change an agent's name, its picture, its model and/or that model's
   * thinking strength, in one call: the sidebar's edit dialog saves them
   * together, and a request that stored one but refused the other would leave
   * the user with half of what they asked for. `icon` undefined → unchanged,
   * null → back to the initial, `{ bytes, extension }` → a new picture;
   * `model` undefined → unchanged, null → the app's default model, a pair →
   * the model to run on (the core also moves the agent's existing
   * conversation to it, now or as its current run ends); `thinkingLevel`
   * undefined → unchanged, `{ provider, modelId, level }` → stores the level
   * for that model (the level belongs to the model, so the request names it). */
  updateStellaAgent(
    id: string,
    patch: {
      name?: string;
      icon?: { bytes: Uint8Array; extension: string } | null;
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: { provider: string; modelId: string; level: string };
    },
  ): Promise<StellaAgent>;
  deleteStellaAgent(id: string): Promise<void>;
  getStellaStatus(): Promise<{
    availability: StellaAvailability;
    state: string;
    vncPort: number | null;
    reason: string;
    starting: boolean;
  }>;
  /** The conversation, created on first use. This is also what brings the
   * machine up: a conversation lives inside it. */
  getOrCreateStellaSession(agentId?: string): Promise<SessionInfo>;
  /** Start the setup turn of an agent that has not been set up yet, once
   * (see LumiscaCore.startStellaOnboarding). False when there is nothing to
   * start — already set up, no open conversation, or a run in flight. */
  startStellaOnboarding(agentId: string): boolean;
  /** Start the setup turn again, for an agent already set up. */
  restartStellaOnboarding(agentId: string): boolean;
  /** Make sure the machine is up, starting it when it is not. Sending is not
   * opening: an already-open conversation never reaches the endpoint above
   * again, so a machine that died since would answer every tool with podman's
   * "container state improper" until the client happened to reload. */
  ensureStellaReady(): Promise<void>;
  /** The conversation a stella agent already has, or undefined. The client
   * addresses the conversation by agent, never by session id. */
  findStellaSession(agentId: string): SessionInfo | undefined;
  /** One window of the conversation as the client draws it (the model's own
   * rows are projected away — see agent/stella-stream.ts). Undefined when the
   * conversation is not open. */
  readStellaConversation(
    sessionId: string,
    query: WindowQuery,
  ): { items: StellaEntry[]; older: string | null } | undefined;
  /** The questions the run is waiting on (the ask tool). */
  getPendingQuestions(sessionId: string): StellaQuestion[];
  /** The screen hand-over the run is blocked on, or null. */
  getPendingHandover(sessionId: string): StellaHandover | null;
  getSessionLastError(sessionId: string): string | undefined;
  getSession(sessionId: string): SessionInfo | undefined;
  /** The thinking level the conversation's model runs at, and the levels it
   * supports (the model's own settings row, read through the session). The
   * composer shows its strength rail from this. */
  getThinkingState(
    sessionId: string,
  ): { thinkingLevel: ThinkingLevel; thinkingLevels: ThinkingLevel[] };
  getAgent(sessionId: string): { isStreaming: boolean } | undefined;
  getStellaAgent(id: string): StellaAgent | undefined;
  openSession(sessionId: string): SessionInfo;
  /** Send a prompt into the conversation (fire-and-forget; the events carry
   * the progress). `uploads` are the files and pictures the user sent: they
   * are already inside the machine, and the message records where. Optional
   * so a caller (a test double, a routine) that only has words does not have
   * to spell out "no attachments". */
  startPrompt(
    sessionId: string,
    text: string,
    images?: never,
    mode?: never,
    files?: PromptFileRef[],
  ): void;
  /** Write a prompt's attached files into the machine (stella is the only
   * surface that accepts them) and return where they are. */
  savePromptUploads(
    sessionId: string,
    uploads: readonly { name: string; bytes: Uint8Array }[],
  ): Promise<PromptFileRef[]>;
  abort(sessionId: string): void;
  rewind(sessionId: string, timestamp: number): Promise<void>;
  /** Part of the shared conversation API's type, not of this surface: a
   * conversation's model is its agent's, so the model route is not mounted
   * here (see ConversationRoutesOptions.modelRoute). */
  setSessionModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): void;
  answerQuestion(
    sessionId: string,
    toolCallId: string,
    answers: AskAnswer[],
  ): void;
  finishHandover(sessionId: string, note: string, toolCallId?: string): void;
  /** Subscribe to the core's event stream (the conversation's WS projects
   * from it; see stellaEventsOf). */
  subscribe(listener: (event: ClientEvent) => void): () => void;
  getSessionRevision(sessionId: string): number;
}

/**
 * The upload body an icon route takes: the base64 bytes and the content type
 * the browser reported. Validated here so the core only ever sees an
 * admissible pair — an empty or oversized payload is refused with its own
 * sentence instead of reaching the store as a broken image.
 */
function parseIconBody(
  body: { data?: unknown; mimeType?: unknown } | undefined,
): { data: string; mimeType: string } {
  const data = body?.data;
  const mimeType = body?.mimeType;
  if (typeof data !== "string" || data.length === 0) {
    throw new AppError("data (base64 image) is required", 400);
  }
  if (typeof mimeType !== "string" || mimeType.length === 0) {
    throw new AppError("mimeType is required", 400);
  }
  // Measured on the encoded text first: a payload far past the limit is
  // rejected without being decoded, and base64 is 4/3 of the bytes it
  // carries (plus the data-URL header some clients leave on).
  if (data.length > Math.ceil(MAX_AGENT_ICON_BYTES * 4 / 3) + 1024) {
    throw new AppError(
      `The icon is too large (limit ${MAX_AGENT_ICON_BYTES} bytes)`,
      400,
    );
  }
  return { data, mimeType };
}

/** Decode base64, with the data-URL header stripped (a client may send what
 * `FileReader` produced). A malformed payload is a 400 rather than a
 * store-level failure: it describes the request, not the server. */
function decodeBase64(data: string): Uint8Array {
  const payload = data.startsWith("data:")
    ? data.slice(data.indexOf(",") + 1)
    : data;
  try {
    return base64ToBytes(payload);
  } catch {
    throw new AppError("data is not valid base64", 400);
  }
}

/** One patch's picture: the new bytes to store, `null` for "back to the
 * initial", or undefined for "leave it alone" (the field was not sent).
 *
 * A malformed value is a 400 rather than a silent no-op: a client that sent
 * something shaped like a picture but could not be read has a bug, and
 * treating it as "unchanged" would report success for a picture that was
 * never stored. */
function parseIconPatch(
  value: unknown,
): { bytes: Uint8Array; extension: string } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const { data, mimeType } = parseIconBody(
    value as { data?: unknown; mimeType?: unknown },
  );
  const extension = agentIconExtensionOfMimeType(mimeType);
  if (extension === undefined) {
    throw new AppError(
      `Icons must be ${AGENT_ICON_FORMATS} (got "${mimeType}")`,
      400,
    );
  }
  return { bytes: decodeBase64(data), extension };
}

/**
 * `{provider, modelId}` of a body field, checked as a pair. Shared by the
 * model patch and the thinking-level patch: both name a model, so both must
 * fail the same way when one half is missing or blank.
 */
function parseModelRef(
  value: unknown,
  field: string,
): { provider: string; modelId: string } {
  if (typeof value !== "object" || value === null) {
    throw new AppError(`${field} must be an object`, 400);
  }
  const body = value as { provider?: unknown; modelId?: unknown };
  // Trimmed before the emptiness check: a body of {"provider": "  "}
  // describes the request, so it is a 400 here rather than an id no catalog
  // has, which the core would refuse with a confusing 404.
  const provider = requireNonEmptyString(body.provider, `${field}.provider`)
    .trim();
  const modelId = requireNonEmptyString(body.modelId, `${field}.modelId`)
    .trim();
  if (provider === "" || modelId === "") {
    throw new AppError(
      `${field}.provider and ${field}.modelId must not be blank`,
      400,
    );
  }
  return { provider, modelId };
}

/**
 * The model patch of an agent edit: `{provider, modelId}` sets the choice,
 * `null` returns the agent to the app's default model, and an absent key
 * means "leave it alone" (the dialog saves only what changed).
 *
 * Only the shape is checked here. Whether the pair names a model this
 * installation can select is the core's question — it is the one that can
 * read the catalog, and it must answer before the row changes.
 */
function parseModelPatch(
  value: unknown,
): { provider: string; modelId: string } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseModelRef(value, "model");
}

/**
 * The thinking-strength patch of an agent edit: the level, and the model it
 * belongs to.
 *
 * The model is named rather than resolved from the agent because the level is
 * a MODEL setting, and the dialog drew its list of levels from the model in
 * effect at that moment. Naming it keeps the two from disagreeing about which
 * model the user was looking at.
 *
 * Only the shape is checked here: whether the model offers the level (and
 * whether the level exists at all) is the core's question, answered before
 * anything is written.
 */
function parseThinkingLevelPatch(
  value: unknown,
): { provider: string; modelId: string; level: string } | undefined {
  if (value === undefined) return undefined;
  const { provider, modelId } = parseModelRef(value, "thinkingLevel");
  const level = requireNonEmptyString(
    (value as { level?: unknown }).level,
    "thinkingLevel.level",
  );
  return { provider, modelId, level };
}

/**
 * The stella machine's API.
 *
 * There is no start / stop / reset route: the machine is started by the code
 * that needs it (the conversation endpoint) and stopped when the server stops.
 * A user who picked stella mode asked for a machine, not for a container to
 * operate, and every control that existed only to move it between states was
 * something to read, understand and get wrong.
 *
 * These routes are mounted unconditionally: a machine that cannot run on this
 * host answers with its reason instead of a 404, so the mode-selection screen
 * can explain itself.
 */
/** The file name a pasted picture is stored under: `image-1.png`,
 * `image-2.jpg`. Its extension comes from the type the browser reported, so
 * the conversation can draw it back without sniffing the bytes (a raster
 * format is what a prompt accepts, and anything else is refused when the
 * upload is saved). */
function imageName(index: number, mimeType: string): string {
  const extension = rasterExtensionOfMimeType(mimeType);
  if (extension === undefined) {
    throw new AppError(
      `Unsupported image type: ${mimeType}`,
      400,
    );
  }
  return `image-${index + 1}${extension}`;
}

export function stellaRoutes(core: StellaApi): Hono {
  const app = new Hono();

  /** What this host can do, and how the machine is doing: the mode-selection
   * screen needs both to decide whether stella can be picked, and stella's
   * view needs the machine's state to connect its screen.
   *
   * The chosen mode is deliberately NOT here: it belongs to each client (see
   * shared/app-mode.ts), so two clients showing one server never drag each
   * other between modes. */
  app.get("/stella/status", async (c) => {
    const status: StellaStatus = await core.getStellaStatus();
    return c.json(status);
  });

  // --- agents (the agent of each conversation) -----------------------------

  /** The sidebar's rows.
   *
   * A row carries what its conversation last said (see
   * shared/stella-preview.ts): a list of agents that says who they are but
   * not what they said is the one thing a message app's list has and this one
   * did not, and only the store knows what was said in a conversation nobody
   * has open.
   *
   * Which conversation a client opens is the client's address, not this
   * list's answer: `/stella/a/<id>` names it, and the app stores the last
   * mode a bare `/` resolves to. A `defaultAgentId` here said the same thing a
   * second time — and said it for every client, which the mode's own choice
   * deliberately does not (see shared/app-mode.ts).
   *
   * Reading the list is also what guarantees the installation has at least
   * one agent: a first run would otherwise open stella mode onto an empty
   * sidebar and a disabled composer, which is a wall in front of the one
   * thing the mode exists for (see ensureStellaAgent). */
  app.get("/stella/agents", async (c) => {
    await core.ensureStellaAgent();
    return c.json({ agents: core.listStellaAgentSummaries() });
  });

  /** Create an agent. `name` and `role` are both optional: creating one is
   * how someone starts talking to an agent, so an empty form must not be a
   * wall. An empty name becomes the default label and an empty role leaves
   * the agent on the app's own instructions (see normalizeAgentInput); the
   * value the server actually stored is what comes back. */
  app.post("/stella/agents", async (c) => {
    const body = await parseBody<{ name?: unknown; role?: unknown }>(c);
    // A duplicate name is a CoreError("conflict"), which app.ts's onError
    // maps to 409 — the client shows it as "that name is taken" rather than
    // as a typo. Re-mapping it here would only re-derive the same table.
    return c.json(
      await core.createStellaAgent({
        name: optionalString(body?.name, "name"),
        role: optionalString(body?.role, "role"),
      }),
      201,
    );
  });

  /** Change what an agent is called, what it looks like, which model its
   * conversation runs on and how hard that model thinks.
   *
   * One route for all four because they are one act: the sidebar's edit
   * dialog saves them together. The body names only what changed — an absent
   * `name`, `icon`, `model` or `thinkingLevel` leaves that field alone,
   * `"icon": null` returns the agent to its initial, `"model": null` returns
   * it to the app's default model (`{provider, modelId}` sets one), and
   * `thinkingLevel: {provider, modelId, level}` stores the level for that
   * model. The picture is the
   * same shape a prompt's images take (`base64` + `mimeType`), and its
   * content type decides the stored format; the store then checks the bytes
   * really are that format, because a browser reports a type from the file's
   * name.
   *
   * What comes back is the updated agent: the client draws the new name,
   * icon and model and needs no second read. Validation is the core's (an
   * empty or taken name is a 400/409, an unknown agent, model or level a
   * 404/400), so the route and the agent's own tools cannot disagree about
   * what a valid choice is. A conversation with a run in flight is not
   * refused: the model is stored and applied when that run ends. */
  app.patch("/stella/agents/:id", async (c) => {
    const body = await parseBody<{
      name?: unknown;
      icon?: unknown;
      model?: unknown;
      thinkingLevel?: unknown;
    }>(c);
    const name = body?.name === undefined
      ? undefined
      : requireNonEmptyString(body.name, "name");
    const icon = parseIconPatch(body?.icon);
    const model = parseModelPatch(body?.model);
    const thinkingLevel = parseThinkingLevelPatch(body?.thinkingLevel);
    return c.json(
      await core.updateStellaAgent(c.req.param("id"), {
        ...(name === undefined ? {} : { name }),
        icon,
        model,
        thinkingLevel,
      }),
    );
  });

  /** Delete an agent and its conversation. The client confirms first: the
   * transcript goes with it. */
  app.delete("/stella/agents/:id", async (c) => {
    await core.deleteStellaAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** The stella conversation, created on first use, plus the snapshot the
   * client draws it from.
   *
   * Addressed by AGENT, not by session: stella has no session concept (one
   * conversation per counterpart, never in a session list), and a client
   * that never learns the session id cannot start treating it as one.
   *
   * Opening is where the machine starts: a conversation needs it, and no
   * other endpoint is guaranteed to run first. A first run builds the image,
   * so the response can take minutes — the client shows that as its one
   * piece of machine state. `getOrCreateStellaSession` does that start
   * itself (a routine opens a conversation without passing through here), so
   * calling it again would only re-ask podman for an answer already known. */
  app.get("/stella/conversations/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    // A cold machine's failure is a CoreError("unavailable") — 503 through
    // the same mapping as every other route; an unknown agent is a
    // CoreError("not_found") — 404.
    const session = await core.getOrCreateStellaSession(agentId);
    // The snapshot describes the conversation BEFORE the app's first turn:
    // it is what the client draws, and the turn then arrives as events (a
    // snapshot that said "running" before the client could see the run would
    // be describing a turn nobody had been shown). A new agent's first turn
    // is the setup turn — the only moment the app may speak before the user
    // does. It is claimed once, so a reload or a second client does not greet
    // anyone twice.
    const snapshot = snapshotOf(
      session,
      agentId,
      parseWindowQuery(c.req.url),
    );
    core.startStellaOnboarding(agentId);
    return c.json(snapshot);
  });

  /** Run an agent's setup turn again.
   *
   * The row menu's "設定をやり直す": a user who skipped the questions, or
   * whose agent has drifted, can be asked again. Opening the conversation
   * first is what brings the machine up; the core then refuses while a run
   * is in flight rather than steering setup text into that work. */
  app.post("/stella/agents/:id/onboarding", async (c) => {
    const agentId = c.req.param("id");
    await core.getOrCreateStellaSession(agentId);
    return c.json({ started: core.restartStellaOnboarding(agentId) });
  });

  /** The conversation re-read after a WS drop or a page reload: a window of
   * the entries, the run state and what the run is waiting on, read in one
   * handler so they describe the same instant. `older` reads further back
   * (see snapshotOf). */
  app.get("/stella/conversations/:agentId/messages", (c) => {
    const agentId = c.req.param("agentId");
    const session = requireConversation(agentId);
    return c.json(snapshotOf(session, agentId, parseWindowQuery(c.req.url)));
  });

  /** The conversation's revision: how many events the server has emitted
   * for it. Cheap (a counter read), so the client polls it and re-reads the
   * snapshot only when it moved. */
  app.get("/stella/conversations/:agentId/revision", (c) => {
    const session = requireConversation(c.req.param("agentId"));
    return c.json({ rev: core.getSessionRevision(session.id) });
  });

  /** Send a prompt. Fire-and-forget: the run's progress arrives on the
   * conversation's event stream.
   *
   * The body is parsed by code mode's own parser (`parsePromptBody`): a
   * conversation takes the same text + images shape, with the same bounds and
   * the same "text may be empty when an image is attached" rule. One parser
   * for the two prompt surfaces means an attachment cannot be accepted on one
   * and silently dropped on the other — which is exactly what a second,
   * narrower parser here had become. */
  app.post("/stella/conversations/:agentId/prompt", async (c) => {
    const body = await parseBody<PromptBody>(c);
    const { text, images, files } = parsePromptBody(body ?? {});
    const session = requireConversation(c.req.param("agentId"));
    // However this conversation was opened, the machine may have stopped
    // since. Every tool runs through `podman exec`, which refuses a stopped
    // container, so the wait belongs here: before the run starts, and before
    // the uploads below are written into the machine.
    await core.ensureStellaReady();
    // Pictures and files take one path: both are written into the machine and
    // the model is told their paths. A picture kept as a byte block in the
    // message would put it in the database for the life of the conversation,
    // and a conversation lives for years (see ai/types.ts UserMessage.files).
    // The copy written into the machine gets the same bound as a stored one
    // (see preparePromptImages).
    const bounded = await preparePromptImages(images);
    const attachments = [
      ...(files ?? []).map((file) => ({
        name: file.name,
        bytes: file.bytes,
      })),
      ...(bounded ?? []).map((image, index) => ({
        name: imageName(index, image.mimeType),
        bytes: base64ToBytes(image.data),
      })),
    ];
    const saved = attachments.length === 0
      ? undefined
      : await core.savePromptUploads(session.id, attachments);
    core.startPrompt(session.id, text, undefined, undefined, saved);
    return c.json({ ok: true });
  });

  /** Stop the run. */
  // Stop, answer and rewind are the handlers a session shares
  // (routes/conversation.ts): only the path and how an id is resolved differ
  // between a conversation and a code-mode session. The model route is not
  // among them: a conversation's model is its agent's (see the agent edit
  // dialog), so there is nothing here to switch.
  conversationRoutes(app, core, {
    base: "/stella/conversations/:agentId",
    resolve: (c) => requireConversation(c.req.param("agentId")!).id,
    modelRoute: false,
  });

  /** The user finished at the screen (`vm_ask_user`): the blocked run
   * continues. */
  app.post("/stella/conversations/:agentId/handover", async (c) => {
    const body = await parseBody<{
      note?: unknown;
      toolCallId?: unknown;
    }>(c);
    const note = body?.note === undefined ? "" : String(body.note);
    const toolCallId = body?.toolCallId;
    if (toolCallId !== undefined && typeof toolCallId !== "string") {
      throw new AppError("toolCallId must be a string", 400);
    }
    const session = requireConversation(c.req.param("agentId"));
    core.finishHandover(
      session.id,
      note,
      typeof toolCallId === "string" ? toolCallId : undefined,
    );
    return c.json({ ok: true });
  });

  /** The conversation's event stream.
   *
   * Its own endpoint rather than a filtered view of `/ws`: the shared
   * stream carries every session's events — tool progress, the panels,
   * compaction — and a stella client would have to know which of them belong
   * to a conversation. Here the server decides once (`stellaEventsOf`), and
   * what is not part of a conversation is never sent. The stream is bound to
   * one agent, so no event carries a session id.
   *
   * The same guards apply as everywhere under `/api` (Host, token, Origin):
   * the WebSocket handshake is an ordinary HTTP GET on the same middleware
   * chain. Heartbeats are transport-level, as on `/ws`. */
  app.get(
    "/stella/conversations/:agentId/events",
    upgradeWebSocket((c) => {
      const agentId = c.req.param("agentId");
      const session = agentId === undefined
        ? undefined
        : core.findStellaSession(agentId);
      // A conversation is only streamed once it exists (the open endpoint
      // creates it); a socket for an unknown agent has nothing to carry.
      if (session === undefined) {
        return {
          onOpen(_event, ws) {
            ws.close(1013, "no conversation for this agent");
          },
          onClose() {},
        };
      }
      const id = session.id;
      return createEventStream({
        subscribe: (listener) => core.subscribe(listener),
        // Only this conversation's events: the shared stream carries every
        // session (code mode's tabs run at the same time).
        accept: (event) => "sessionId" in event && event.sessionId === id,
        revOf: () => core.getSessionRevision(id),
        // No streaming TEXT: a message appears whole when its turn ends (the
        // agent's final text, or what it sent with `send_chat`), so a
        // `message_delta` has nothing to add and the projection drops it with
        // every other model-only event. A card is the exception — it is drawn
        // while the model writes it — so its fragments are batched like a
        // reply's text, keyed by the call they belong to.
        delta: {
          accepts: (event) =>
            event.type === "card_delta" && event.sessionId === id,
          key: (event) => event.type === "card_delta" ? event.toolCallId : "",
          frame: ({ key, delta, rev, events }) => ({
            type: "card_delta",
            toolCallId: key,
            delta,
            rev,
            events,
          }),
        },
        project: (event, rev) =>
          stellaEventsOf(event).map((projected) => ({ ...projected, rev })),
      });
    }),
  );

  /** The agent's conversation, or 404. The conversation is created by the
   * open endpoint; every other call addresses one that exists.
   *
   * The agent must exist (a deleted agent's conversation is gone with it),
   * and it must have been opened at least once. `findStellaSession` is the
   * only lookup that needs no session id — a client never learns one. */
  function requireConversation(agentId: string): SessionInfo {
    const agent = core.getStellaAgent(agentId);
    if (agent === undefined) {
      throw new AppError(`Agent not found: ${agentId}`, 404);
    }
    const session = core.findStellaSession(agentId);
    if (session === undefined) {
      throw new AppError(
        `No conversation for agent ${agentId}: open it first`,
        404,
      );
    }
    return session;
  }

  /** One conversation snapshot: a window of the entries as the client draws
   * them plus the live state the event stream cannot restore on its own. */
  function snapshotOf(
    session: SessionInfo,
    agentId: string,
    query: WindowQuery,
  ): StellaConversationSnapshot {
    const page = core.readStellaConversation(session.id, query);
    if (page === undefined) {
      // Unreachable: every caller opened the conversation (open, or a route
      // that requires an existing one), and a conversation is only ever
      // read while it is open. Do not invent an empty transcript for it.
      throw new AppError(`Conversation is not open: ${agentId}`, 409);
    }
    return {
      entries: page.items,
      // The way back through the conversation; null at its beginning.
      older: page.older,
      running: core.getAgent(session.id)?.isStreaming === true,
      questions: core.getPendingQuestions(session.id),
      handover: core.getPendingHandover(session.id),
      ...(lastErrorOf(session.id) !== undefined
        ? { error: lastErrorOf(session.id) }
        : {}),
      agentName: core.getStellaAgent(agentId)?.name ?? session.name,
      sessionId: session.id,
      // The model the conversation runs on. The client shows it in the
      // composer's model line, and switches from there; the conversation's
      // session row is the source of truth, so it travels with the snapshot
      // rather than being guessed from the app default.
      model: { provider: session.modelProvider, modelId: session.modelId },
      // The model's thinking strength, beside the model for the same reason:
      // the composer shows both from one line, and a stella request that
      // takes many steps is where the choice matters most.
      ...core.getThinkingState(session.id),
      rev: core.getSessionRevision(session.id),
    };
  }

  function lastErrorOf(sessionId: string): string | undefined {
    return core.getSessionLastError(sessionId);
  }

  return app;
}
