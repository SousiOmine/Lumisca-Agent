import type { PromptFileRef } from "@lumisca/core";
import { stellaEventsOf } from "@lumisca/core";
import type { StellaMachineStatus, StellaStatus } from "@lumisca/core/shared";
import { paths, routePath } from "@lumisca/core/shared";
import { Hono } from "hono";
import type { StellaApi } from "../contracts/stella.ts";
import { upgradeWebSocket } from "../websocket.ts";
import { conversationRoutes } from "./conversation.ts";
import type { PromptUploadSink } from "./prompt-uploads.ts";
import { type PromptBody, parsePromptBody } from "./session-requests.ts";
import {
  parseEnabledPatch,
  parseIconPatch,
  parseModelPatch,
  parseThinkingLevelPatch,
  requireAgent,
  requireConversation,
  requireEnabledAgent,
  savePromptPictures,
} from "./stella-requests.ts";
import { readOnlySnapshot, snapshotOf } from "./stella-snapshot.ts";
import {
  AppError,
  optionalString,
  optionalToolCallId,
  parseBody,
  parseWindowQuery,
  requireNonEmptyString,
} from "./util.ts";
import { createEventStream } from "./ws-stream.ts";

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
export function stellaRoutes(
  core: StellaApi,
  promptUploads?: PromptUploadSink,
): Hono {
  const app = new Hono();

  /** What this host can do, and how the machine is doing: the mode-selection
   * screen needs both to decide whether stella can be picked, and stella's
   * view needs the machine's state to connect its screen.
   *
   * The chosen mode is deliberately NOT here: it belongs to each client (see
   * shared/app-mode.ts), so two clients showing one server never drag each
   * other between modes. */
  app.get(routePath(paths.stellaStatus), async (c) => {
    const status: StellaStatus = await core.getStellaStatus();
    return c.json(status);
  });

  /** One agent's machine: whether it is running, asleep or being started.
   * The client polls this for the conversation it has open, so the screen
   * pane can say "asleep" instead of failing to connect, and offer to wake
   * it. */
  app.get(routePath(paths.stellaAgentMachine), async (c) => {
    const status: StellaMachineStatus = await core.getStellaAgentStatus(
      c.req.param("id"),
    );
    return c.json(status);
  });

  /** Wake one agent's machine without sending a prompt (the pane's "wake"
   * button). */
  app.post(routePath(paths.stellaAgentWake), async (c) => {
    await core.wakeStellaAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** The user did something on the machine's screen. The idle clock starts
   * here, so driving the screen keeps it awake; a pane left open with nobody
   * at it does not. */
  app.post(routePath(paths.stellaAgentTouch), (c) => {
    const agentId = c.req.param("id");
    requireEnabledAgent(core, agentId);
    core.touchStellaAgent(agentId);
    return c.json({ ok: true });
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
   * list's answer: `/agents/<id>` names it, and the app stores the last
   * mode a bare `/` resolves to. A `defaultAgentId` here said the same thing a
   * second time — and said it for every client, which the mode's own choice
   * deliberately does not (see shared/app-mode.ts).
   *
   * Reading the list is also what guarantees the installation has at least
   * one agent: a first run would otherwise open stella mode onto an empty
   * sidebar and a disabled composer, which is a wall in front of the one
   * thing the mode exists for (see ensureStellaAgent). */
  app.get(routePath(paths.stellaAgents), async (c) => {
    await core.ensureStellaAgent();
    return c.json({ agents: core.listStellaAgentSummaries() });
  });

  /** Create an agent. `name` and `role` are both optional: creating one is
   * how someone starts talking to an agent, so an empty form must not be a
   * wall. An empty name becomes the default label and an empty role leaves
   * the agent on the app's own instructions (see normalizeAgentInput); the
   * value the server actually stored is what comes back. */
  app.post(routePath(paths.stellaAgents), async (c) => {
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
   * conversation runs on, how hard that model thinks, and whether it is
   * switched on.
   *
   * One route because they are one act: the sidebar's edit dialog saves the
   * first four together, and the row's menu flips `enabled`. The body names
   * only what changed — an absent `name`, `icon`, `model`, `thinkingLevel`
   * or `enabled` leaves that field alone, `"icon": null` returns the agent
   * to its initial, `"model": null` returns it to the app's default model
   * (`{provider, modelId}` sets one), `thinkingLevel: {provider, modelId,
   * level}` stores the level for that model, `"enabled": false` switches the
   * agent off and `"enabled": true` switches it back on. The picture is the
   * same shape a prompt's images take (`base64` + `mimeType`), and its
   * content type decides the stored format; the store then checks the bytes
   * really are that format, because a browser reports a type from the file's
   * name.
   *
   * What comes back is the updated agent: the client draws the new name,
   * icon, model and on/off state and needs no second read. Validation is the
   * core's (an empty or taken name is a 400/409, an unknown agent, model or
   * level a 404/400), so the route and the agent's own tools cannot disagree
   * about what a valid choice is. A conversation with a run in flight is not
   * refused: the model is stored and applied when that run ends, and
   * switching the agent off aborts that run as it closes the conversation. */
  app.patch(routePath(paths.stellaAgent), async (c) => {
    const body = await parseBody<{
      name?: unknown;
      icon?: unknown;
      model?: unknown;
      thinkingLevel?: unknown;
      enabled?: unknown;
    }>(c);
    const name =
      body?.name === undefined
        ? undefined
        : requireNonEmptyString(body.name, "name");
    const icon = parseIconPatch(body?.icon);
    const model = parseModelPatch(body?.model);
    const thinkingLevel = parseThinkingLevelPatch(body?.thinkingLevel);
    const enabled = parseEnabledPatch(body?.enabled);
    return c.json(
      await core.updateStellaAgent(c.req.param("id"), {
        ...(name === undefined ? {} : { name }),
        icon,
        model,
        thinkingLevel,
        ...(enabled === undefined ? {} : { enabled }),
      }),
    );
  });

  /** Delete an agent and its conversation. The client confirms first: the
   * transcript goes with it. */
  app.delete(routePath(paths.stellaAgent), async (c) => {
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
  app.get(routePath(paths.conversation), async (c) => {
    const agentId = c.req.param("agentId");
    const query = parseWindowQuery(c.req.url);
    const agent = requireAgent(core, agentId);
    // A disabled agent's conversation is read-only history: nothing is
    // built, the machine is not started and no first turn is claimed. The
    // entries come straight from the store (see readOnlySnapshot).
    if (agent.disabledAt !== null) {
      return c.json(readOnlySnapshot(core, agent, query));
    }
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
    const snapshot = snapshotOf(core, session, agentId, query);
    core.startStellaOnboarding(agentId);
    return c.json(snapshot);
  });

  /** The conversation re-read after a WS drop or a page reload: a window of
   * the entries, the run state and what the run is waiting on, read in one
   * handler so they describe the same instant. `older` reads further back
   * (see snapshotOf). */
  app.get(routePath(paths.conversationMessages), (c) => {
    const agentId = c.req.param("agentId");
    const query = parseWindowQuery(c.req.url);
    const agent = requireAgent(core, agentId);
    // A disabled conversation is re-read the same way it was opened: from
    // the store, whether or not a session row exists yet.
    if (agent.disabledAt !== null) {
      return c.json(readOnlySnapshot(core, agent, query));
    }
    const session = requireConversation(core, agentId);
    return c.json(snapshotOf(core, session, agentId, query));
  });

  /** Search the conversation's full history (including turns before the
   * latest compaction checkpoint), newest matches first. Works for disabled
   * agents too so archived history remains searchable. */
  app.get(routePath(paths.conversationSearch), (c) => {
    const agentId = c.req.param("agentId");
    requireAgent(core, agentId);
    const q = (c.req.query("q") ?? "").trim();
    if (q.length === 0) return c.json({ entries: [] });
    const session = core.findStellaSession(agentId);
    if (session === undefined) return c.json({ entries: [] });
    return c.json({ entries: core.searchStellaConversation(session.id, q) });
  });

  /** The conversation's revision: how many events the server has emitted
   * for it. Cheap (a counter read), so the client polls it and re-reads the
   * snapshot only when it moved. */
  app.get(routePath(paths.conversationRevision), (c) => {
    const session = requireConversation(core, c.req.param("agentId"));
    return c.json({ rev: core.getSessionRevision(session.id) });
  });

  /** Send a prompt. Fire-and-forget: the run's progress arrives on the
   * conversation's event stream.
   *
   * The body is parsed by code mode's own parser (`parsePromptBody`): a
   * conversation takes the same text + images shape, with the same bounds and
   * the same "text may be empty when an image or an uploaded file is attached"
   * rule. One parser for the two prompt surfaces means an attachment cannot be
   * accepted on one and silently dropped on the other. */
  app.post(routePath(paths.conversationPrompt), async (c) => {
    const body = await parseBody<PromptBody>(c);
    const { text, images, uploads } = parsePromptBody(body ?? {});
    const agentId = c.req.param("agentId");
    // Refused BEFORE anything is written into the machine or started: a
    // disabled agent has no run to send to, and `ensureStellaReady` below
    // would bring the whole machine up for a message nobody can deliver.
    requireEnabledAgent(core, agentId);
    const session = requireConversation(core, agentId);
    // However this conversation was opened, its machine may be asleep: the
    // server stops one nobody has used for a while, and every tool runs
    // through `podman exec`, which refuses a stopped container. The wait
    // belongs here — before the run starts and before the pictures below are
    // written into the machine — and the skill catalog is read after the
    // wake, because a sleeping machine is not read (see
    // StellaMachine.ensureSkills).
    await core.ensureStellaReady(agentId);
    await core.ensureStellaSkills(agentId);
    // Pictures and files take one path: both end up in the machine and the
    // model is told their paths. A picture kept as a byte block in the message
    // would put it in the database for the life of the conversation, and a
    // conversation lives for years (see ai/types.ts UserMessage.files).
    //
    // Files arrived first: the browser uploaded them in chunks and the upload
    // route copied each into the machine (see prompt-uploads.ts). This route
    // only asks the store what those ids now name. Pictures still ride in the
    // prompt body, bounded before they are written (prepareStoredImage).
    let fileRefs: PromptFileRef[] = [];
    if (uploads !== undefined) {
      if (promptUploads === undefined) {
        throw new AppError(
          "This server has no upload store; update it and attach the files again",
          409,
        );
      }
      fileRefs = promptUploads.resolve(agentId, uploads);
    }
    const imageRefs = await savePromptPictures(core, session.id, images);
    const saved = [...fileRefs, ...(imageRefs ?? [])];
    core.startPrompt(
      session.id,
      text,
      undefined,
      undefined,
      saved.length === 0 ? undefined : saved,
    );
    if (uploads !== undefined) promptUploads?.release(uploads);
    return c.json({ ok: true });
  });

  /** Stop the run. */
  // Stop, answer and rewind are the handlers a session shares
  // (routes/conversation.ts): only the path and how an id is resolved differ
  // between a conversation and a code-mode session. The model route is not
  // among them: a conversation's model is its agent's (see the agent edit
  // dialog), so there is nothing here to switch.
  conversationRoutes(app, core, {
    base: paths.conversation,
    resolve: (c) => requireConversation(core, c.req.param("agentId")!).id,
    modelRoute: false,
  });

  /** The user finished at the screen (`vm_ask_user`): the blocked run
   * continues. */
  app.post(routePath(paths.conversationHandover), async (c) => {
    const body = await parseBody<{
      note?: unknown;
      toolCallId?: unknown;
    }>(c);
    const note = body?.note === undefined ? "" : String(body.note);
    const toolCallId = optionalToolCallId(body?.toolCallId);
    const session = requireConversation(core, c.req.param("agentId"));
    core.finishHandover(session.id, note, toolCallId);
    return c.json({ ok: true });
  });

  /** The user entered a value for the environment variable `vm_env` asked
   * about: store it in the machine and let the blocked run continue.
   *
   * The name is the one the agent asked for — taken from the pending
   * request, never from this body — so a dialog can only fill the question
   * it was opened for. Nothing about the value is echoed back or logged. */
  app.post(routePath(paths.conversationEnv), async (c) => {
    const body = await parseBody<{
      value?: unknown;
      toolCallId?: unknown;
    }>(c);
    const toolCallId = optionalToolCallId(body?.toolCallId);
    const session = requireConversation(core, c.req.param("agentId"));
    await core.provideStellaEnv(session.id, body?.value, toolCallId);
    return c.json({ ok: true });
  });

  /** The user refused to enter a value (or closed the dialog). Not an
   * error: the run continues without the variable. */
  app.post(routePath(paths.conversationEnvDecline), async (c) => {
    const body = await parseBody<{ toolCallId?: unknown }>(c);
    const toolCallId = optionalToolCallId(body?.toolCallId);
    const session = requireConversation(core, c.req.param("agentId"));
    core.declineStellaEnv(session.id, toolCallId);
    return c.json({ ok: true });
  });

  /** The user lent a folder (`share_request`): let the blocked run continue.
   *
   * The tool call is named by the body so a card that outlived its run cannot
   * answer a different request; the folder itself is never named here — the
   * server's list of loans is what the tool reads, so a client cannot tell
   * the model that a folder exists when it does not. */
  app.post(routePath(paths.conversationShareLend), async (c) => {
    const body = await parseBody<{ toolCallId?: unknown }>(c);
    const toolCallId = optionalToolCallId(body?.toolCallId);
    const session = requireConversation(core, c.req.param("agentId"));
    core.finishShareLend(session.id, toolCallId);
    return c.json({ ok: true });
  });

  /** The user refused to lend a folder. Not an error: the run continues
   * without one. */
  app.post(routePath(paths.conversationShareDecline), async (c) => {
    const body = await parseBody<{ toolCallId?: unknown }>(c);
    const toolCallId = optionalToolCallId(body?.toolCallId);
    const session = requireConversation(core, c.req.param("agentId"));
    core.declineShareRequest(session.id, toolCallId);
    return c.json({ ok: true });
  });

  /** The desktop app answered `share_disconnect`: it withdrew the loan
   * (`ok: true`), or it could not and said why. The reason is handed to the
   * blocked tool as it was given — the shell's own words are what the model
   * can act on. */
  app.post(routePath(paths.conversationShareDisconnect), async (c) => {
    const body = await parseBody<{
      toolCallId?: unknown;
      ok?: unknown;
      error?: unknown;
    }>(c);
    const toolCallId = body?.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId === "") {
      throw new AppError("toolCallId (string) is required", 400);
    }
    const ok = body?.ok;
    if (typeof ok !== "boolean") {
      throw new AppError("ok (boolean) is required", 400);
    }
    const session = requireConversation(core, c.req.param("agentId"));
    if (ok) {
      core.finishShareDisconnect(session.id, toolCallId);
      return c.json({ ok: true });
    }
    const error = body?.error;
    if (typeof error !== "string" || error.trim() === "") {
      throw new AppError("error (string) is required when ok is false", 400);
    }
    core.failShareDisconnect(session.id, toolCallId, error);
    return c.json({ ok: true });
  });

  /** The machine's clipboard, for the chat's screen pane.
   *
   * The pane cannot use the VNC connection for it: x11vnc speaks the standard
   * RFB cut text, which is ISO 8859-1, so a Japanese message would arrive as
   * question marks in either direction. The text crosses into the machine as
   * one `xclip` call instead (see vm/clipboard.ts).
   *
   * WRITING needs the hand-over: while the agent works the screen is its own,
   * and two people changing one clipboard is the same bug as two pointers.
   * Reading does not: it returns what is already on the screen, and refusing
   * it while a hand-over is ending would fail a request that changed nothing.
   */
  app.get(routePath(paths.conversationClipboard), async (c) => {
    const agentId = c.req.param("agentId")!;
    requireEnabledAgent(core, agentId);
    const session = requireConversation(core, agentId);
    const text = await core.readStellaClipboard(session.id);
    return c.json({ text });
  });

  app.post(routePath(paths.conversationClipboard), async (c) => {
    const agentId = c.req.param("agentId")!;
    requireEnabledAgent(core, agentId);
    const session = requireConversation(core, agentId);
    if (core.getPendingHandover(session.id) === null) {
      throw new AppError("The screen is not handed over to the user", 409);
    }
    const body = await parseBody<{ text?: unknown }>(c);
    if (typeof body?.text !== "string") {
      throw new AppError("text (string) is required", 400);
    }
    await core.writeStellaClipboard(session.id, body.text);
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
    routePath(paths.conversationEvents),
    upgradeWebSocket((c) => {
      const agentId = c.req.param("agentId");
      // A disabled agent has no run and no event: a socket would sit silent
      // for as long as the tab stays open. Closed at once, like a
      // conversation that does not exist.
      const agent =
        agentId === undefined ? undefined : core.getStellaAgent(agentId);
      if (agent !== undefined && agent.disabledAt !== null) {
        return {
          onOpen(_event, ws) {
            ws.close(1013, "the agent is disabled");
          },
          onClose() {},
        };
      }
      const session =
        agentId === undefined ? undefined : core.findStellaSession(agentId);
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
        // reply's text, keyed by the card they belong to.
        delta: {
          accepts: (event) =>
            event.type === "ui_delta" && event.sessionId === id,
          key: (event) => (event.type === "ui_delta" ? event.toolCallId : ""),
          frame: ({ key, delta, rev, events }) => ({
            type: "ui_delta",
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

  return app;
}
