import { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type {
  AskAnswer,
  ClientEvent,
  SessionInfo,
  SkillInfo,
  StellaAgent,
  StellaConversationSnapshot,
  StellaEntry,
  StellaHandover,
  StellaQuestion,
  WindowQuery,
} from "@lumisca/core";
import type { StellaAvailability } from "@lumisca/core";
import {
  base64ToBytes,
  CoreError,
  errorMessage,
  stellaEventsOf,
} from "@lumisca/core";
import {
  AGENT_ICON_FORMATS,
  agentIconExtensionOfMimeType,
  MAX_AGENT_ICON_BYTES,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_TYPE,
} from "@lumisca/core/shared";
import {
  AppError,
  parseBody,
  parseWindowQuery,
  requireNonEmptyString,
  requireNumber,
} from "./util.ts";
import { parseAnswerBody } from "./sessions.ts";
import { assetHeaders } from "./asset-headers.ts";

/** The slice of the core these routes need (interface segregation). */
export interface StellaApi {
  listStellaAgents(): StellaAgent[];
  /** Create the starter agent a fresh installation talks to, unless one
   * already exists. Returns the agent a client opens. */
  ensureStellaAgent(): StellaAgent;
  createStellaAgent(input: { name: string; role: string }): StellaAgent;
  renameStellaAgent(id: string, name: string): StellaAgent;
  /** Store the picture the user picked and point the agent at it. */
  setStellaAgentIcon(
    id: string,
    input: { bytes: Uint8Array; extension: string },
  ): Promise<StellaAgent>;
  /** Return the agent to its initial on a generated colour. */
  clearStellaAgentIcon(id: string): Promise<StellaAgent>;
  /** The icon file one of an agent's names refers to (the route serves it).
   * Undefined for an unknown name or a file that is gone. */
  resolveStellaAgentIcon(
    id: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined>;
  deleteStellaAgent(id: string): Promise<void>;
  getStellaAvailability(): Promise<StellaAvailability>;
  getStellaStatus(): Promise<{
    availability: StellaAvailability;
    state: string;
    vncPort: number | null;
    reason: string;
    starting: boolean;
  }>;
  /** Bring the machine up if it is not (the first conversation starts it). */
  ensureStellaReady(): Promise<void>;
  getOrCreateStellaSession(agentId?: string): Promise<SessionInfo>;
  /** The conversation a stella agent already has, or undefined. The client
   * addresses the conversation by agent, never by session id. */
  findStellaSession(agentId: string): SessionInfo | undefined;
  listStellaSkills(): SkillInfo[];
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
  getAgent(sessionId: string): { isStreaming: boolean } | undefined;
  getStellaAgent(id: string): StellaAgent | undefined;
  openSession(sessionId: string): SessionInfo;
  /** Send a prompt into the conversation (fire-and-forget; the events carry
   * the progress). */
  startPrompt(sessionId: string, text: string): void;
  abort(sessionId: string): void;
  rewind(sessionId: string, timestamp: number): Promise<void>;
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
    const status = await core.getStellaStatus();
    return c.json({
      availability: status.availability,
      state: status.state,
      vncPort: status.vncPort,
      reason: status.reason,
      starting: status.starting,
    });
  });

  // --- agents (the agent of each conversation) -----------------------------

  /** The sidebar's list, most recently used first, plus which one a fresh
   * screen opens.
   *
   * Reading the list is also what guarantees the installation has at least
   * one agent: a first run would otherwise open stella mode onto an empty
   * sidebar and a disabled composer, which is a wall in front of the one
   * thing the mode exists for (see ensureStellaAgent). */
  app.get("/stella/agents", (c) => {
    const starter = core.ensureStellaAgent();
    return c.json({
      agents: core.listStellaAgents(),
      defaultAgentId: starter.id,
    });
  });

  app.post("/stella/agents", async (c) => {
    const body = await parseBody<{ name?: unknown; role?: unknown }>(c);
    const name = requireNonEmptyString(body?.name, "name");
    const role = requireNonEmptyString(body?.role, "role");
    try {
      return c.json(core.createStellaAgent({ name, role }), 201);
    } catch (error) {
      // A duplicate name is a conflict (409), not a malformed request: the
      // client shows it as "that name is taken" rather than as a typo.
      throw new AppError(
        errorMessage(error),
        error instanceof CoreError && error.kind === "conflict" ? 409 : 400,
      );
    }
  });

  app.patch("/stella/agents/:id", async (c) => {
    const body = await parseBody<{ name?: unknown }>(c);
    const name = requireNonEmptyString(body?.name, "name");
    try {
      return c.json(core.renameStellaAgent(c.req.param("id"), name));
    } catch (error) {
      throw new AppError(
        errorMessage(error),
        error instanceof CoreError && error.kind === "not_found" ? 404 : 400,
      );
    }
  });

  /** Delete an agent and its conversation. The client confirms first: the
   * transcript goes with it. */
  app.delete("/stella/agents/:id", async (c) => {
    await core.deleteStellaAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  // --- agents' icons (the picture each is drawn with) ----------------------

  /** Set the agent's picture. The body is the same shape a prompt's images
   * take (`base64` + `mimeType`): the browser already has the bytes, and the
   * image endpoints across the app speak that one shape.
   *
   * The content type decides the stored format, and the store then checks the
   * bytes really are that format — a browser reports a type from the file's
   * name, so it is a claim, not a fact. What comes back is the updated agent:
   * the client draws `icon` and needs no second read. */
  app.put("/stella/agents/:id/icon", async (c) => {
    const body = await parseBody<{ data?: unknown; mimeType?: unknown }>(c);
    const { data, mimeType } = parseIconBody(body);
    const extension = agentIconExtensionOfMimeType(mimeType);
    if (extension === undefined) {
      throw new AppError(
        `Icons must be ${AGENT_ICON_FORMATS} (got "${mimeType}")`,
        400,
      );
    }
    try {
      return c.json(
        await core.setStellaAgentIcon(c.req.param("id"), {
          bytes: decodeBase64(data),
          extension,
        }),
      );
    } catch (error) {
      throw new AppError(
        errorMessage(error),
        error instanceof CoreError && error.kind === "not_found" ? 404 : 400,
      );
    }
  });

  /** Back to the initial on a generated colour: the row's reference and the
   * file both go. Answers the updated agent, like the upload above. */
  app.delete("/stella/agents/:id/icon", async (c) => {
    try {
      return c.json(await core.clearStellaAgentIcon(c.req.param("id")));
    } catch (error) {
      throw new AppError(
        errorMessage(error),
        error instanceof CoreError && error.kind === "not_found" ? 404 : 400,
      );
    }
  });

  /** The picture itself.
   *
   * Named by the file the store generated, not by the agent alone: a
   * replaced picture keeps the OLD URL valid for whatever already drew it
   * (the answer is cacheable forever, and a URL that changed content would
   * keep showing the old face), while a fresh upload gets a fresh name. The
   * agent must exist — a name alone must not tell a caller whether one ever
   * did — and the store answers only names it generated. */
  app.get("/stella/agents/:id/icon/:name", async (c) => {
    const agentId = c.req.param("id");
    if (core.getStellaAgent(agentId) === undefined) {
      throw new AppError(`Agent not found: ${agentId}`, 404);
    }
    const icon = await core.resolveStellaAgentIcon(
      agentId,
      c.req.param("name"),
    );
    if (icon === undefined) {
      throw new AppError(`Icon not found: ${c.req.param("name")}`, 404);
    }
    const bytes = await Deno.readFile(icon.path);
    return new Response(bytes, {
      headers: assetHeaders({ mimeType: icon.mimeType }),
    });
  });

  /** The stella conversation, created on first use, plus the snapshot the
   * client draws it from.
   *
   * Addressed by AGENT, not by session: stella has no session concept (one
   * conversation per counterpart, never in a session list), and a client
   * that never learns the session id cannot start treating it as one.
   *
   * This is also where the machine starts: a conversation needs it, and no
   * other endpoint is guaranteed to run first. A first run builds the image,
   * so the response can take minutes — the client shows that as its one
   * piece of machine state. */
  app.get("/stella/conversations/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    try {
      await core.ensureStellaReady();
      const session = await core.getOrCreateStellaSession(agentId);
      return c.json(
        snapshotOf(session, agentId, parseWindowQuery(c.req.url)),
      );
    } catch (error) {
      throw new AppError(
        errorMessage(error),
        error instanceof CoreError && error.kind === "not_found" ? 404 : 503,
      );
    }
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
   * conversation's event stream. */
  app.post("/stella/conversations/:agentId/prompt", async (c) => {
    const body = await parseBody<{ text?: unknown }>(c);
    const text = requireNonEmptyString(body?.text, "text");
    const session = requireConversation(c.req.param("agentId"));
    core.startPrompt(session.id, text);
    return c.json({ ok: true });
  });

  /** Stop the run. */
  app.post("/stella/conversations/:agentId/abort", (c) => {
    const session = requireConversation(c.req.param("agentId"));
    core.abort(session.id);
    return c.json({ ok: true });
  });

  /** Answer the questions the run is blocked on (the ask tool). */
  app.post("/stella/conversations/:agentId/answer", async (c) => {
    const body = await parseBody<{
      toolCallId?: unknown;
      answers?: unknown;
    }>(c);
    const toolCallId = requireNonEmptyString(body?.toolCallId, "toolCallId");
    const answers = parseAnswerBody({
      toolCallId,
      answers: body?.answers as AskAnswer[],
    }).answers;
    const session = requireConversation(c.req.param("agentId"));
    core.answerQuestion(session.id, toolCallId, answers);
    return c.json({ ok: true });
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

  /** Rewind the conversation from a message onward. The message is named by
   * its timestamp (the same value the entry carries), and everything the
   * model produced after it goes too — including the rows the conversation
   * never showed. */
  app.post("/stella/conversations/:agentId/rewind", async (c) => {
    const body = await parseBody<{ timestamp?: unknown }>(c);
    const timestamp = requireNumber(body?.timestamp, "timestamp (number)");
    const session = requireConversation(c.req.param("agentId"));
    await core.openSession(session.id);
    await core.rewind(session.id, timestamp);
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
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      return {
        onOpen(_event, ws) {
          const send = (payload: unknown) => {
            try {
              ws.send(JSON.stringify(payload));
            } catch {
              // The socket closed between the event and the send.
            }
          };
          const session = agentId === undefined
            ? undefined
            : core.findStellaSession(agentId);
          if (session === undefined) {
            ws.close(1013, "no conversation for this agent");
            return;
          }
          const id = session.id;
          unsubscribe = core.subscribe((event) => {
            // Only this conversation's events: the shared stream carries
            // every session (code mode's tabs run at the same time).
            if (!("sessionId" in event) || event.sessionId !== id) return;
            for (const projected of stellaEventsOf(event)) {
              send({
                ...projected,
                rev: core.getSessionRevision(id),
              });
            }
          });
          heartbeat = setInterval(
            () => send({ type: WS_HEARTBEAT_TYPE }),
            WS_HEARTBEAT_INTERVAL_MS,
          );
        },
        onClose() {
          if (heartbeat !== undefined) clearInterval(heartbeat);
          unsubscribe?.();
        },
      };
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
      rev: core.getSessionRevision(session.id),
    };
  }

  function lastErrorOf(sessionId: string): string | undefined {
    return core.getSessionLastError(sessionId);
  }

  return app;
}
