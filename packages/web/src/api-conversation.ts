/**
 * The five calls a code-mode session and a stella conversation both answer:
 * revision, prompt, abort, rewind and answer.
 *
 * The server installs them from one builder (routes/conversation.ts) — the two
 * families differ there only in their base path and in how a request's id is
 * resolved. The client had the same five written twice, in api-local.ts (a
 * session) and api-stella.ts (a conversation), each copy spelling the method,
 * the body and the answer; a fix to one (what a prompt carries, how an answer
 * is shaped) could miss the other, and only one of the two surfaces would
 * break. This module is the client's one statement of them: the path, the
 * method, the body and the answer's shape are written here once, and a family
 * supplies only what really differs.
 *
 * What differs:
 *
 * - the templates (core/shared/api-paths.ts) and the hole a family's id fills
 *   — a session's is `{id}`, a conversation's `{agentId}`;
 * - the tail of a prompt: a session's is the composer's `mode` badge (its
 *   prompt route refuses uploaded files outright — only a conversation has a
 *   machine to put one in), a conversation's is the files it moved into its
 *   machine first (see prompt-upload.ts);
 * - the machine: a session may live on a peer, so the table names it first and
 *   goes through `sessionRequest`; a conversation is always this
 *   installation's, whose entry is the empty peer id.
 */
import { type AskAnswer, enc, paths } from "@lumisca/core/shared";
import { apiPathOf, promptBody } from "./api-client.ts";
import type { ModePrompt, PendingFile, PendingImage } from "./types.ts";

/** One family of conversations: where its five calls live, and what the tail of
 * its prompt is (`Tail`). `idParam` is the hole its id fills, named after the
 * parameter the server's handlers read (`c.req.param`), so a family cannot
 * name its id one way and register the route another. */
export interface ConversationFamily<Tail> {
  idParam: "id" | "agentId";
  revision: string;
  prompt: string;
  abort: string;
  rewind: string;
  answer: string;
  /** A prompt's body from its text, its pictures and the caller's tail. Both
   * families build it with `promptBody`, so a picture or a finished upload
   * means the same thing in either mode; only the tail differs. */
  body: (
    text: string,
    images: PendingImage[] | undefined,
    tail: Tail | undefined,
  ) => object;
}

/** A code-mode session (server/routes/sessions.ts). */
export const sessionFamily: ConversationFamily<ModePrompt> = {
  idParam: "id",
  revision: paths.sessionRevision,
  prompt: paths.sessionPrompt,
  abort: paths.sessionAbort,
  rewind: paths.sessionRewind,
  answer: paths.sessionAnswer,
  body: (text, images, mode) => promptBody(text, images, mode),
};

/** A stella conversation, addressed by the agent that owns it
 * (server/routes/stella.ts). */
export const stellaFamily: ConversationFamily<PendingFile[]> = {
  idParam: "agentId",
  revision: paths.conversationRevision,
  prompt: paths.conversationPrompt,
  abort: paths.conversationAbort,
  rewind: paths.conversationRewind,
  answer: paths.conversationAnswer,
  body: (text, images, files) => promptBody(text, images, undefined, files),
};

/** How one call reaches its conversation: the peer id of the machine that owns
 * it ("" = this server, see `sessionRequest`), the path the family's template
 * was filled into — below the `/api` mount (or below the fed proxy's prefix) —
 * and the request's own init. */
export type ConversationRequest = <T>(
  peerId: string,
  path: string,
  init?: RequestInit,
) => Promise<T>;

/** The five calls of one family, on the machine the peer id names. The shape
 * is api-local.ts's route tables (peer id, then the conversation's id, then the
 * call's own args), so both surfaces can bind it with the same
 * `sessionCalls`/`tabCalls`. */
export function conversationCalls<Tail>(
  family: ConversationFamily<Tail>,
  send: ConversationRequest,
) {
  const pathOf = (template: string, id: string) =>
    apiPathOf(template, { [family.idParam]: enc(id) });

  return {
    /** How many events the owning server has emitted for it. A counter read
     * that opens nothing, so the client polls it and re-reads the snapshot only
     * when it moved: a missed frame is then noticed without re-reading. */
    getRevision: (peerId: string, id: string) =>
      send<{ rev: number }>(peerId, pathOf(family.revision, id)),

    /** Fire-and-forget: the run's progress arrives on the event stream. */
    prompt: (
      peerId: string,
      id: string,
      text: string,
      images?: PendingImage[],
      tail?: Tail,
    ) =>
      send<{ ok: true }>(peerId, pathOf(family.prompt, id), {
        method: "POST",
        body: JSON.stringify(family.body(text, images, tail)),
      }),

    /** Stop the run. A no-op that still answers `ok` when nothing is running:
     * the button is also how a client recovers from a stream it lost. */
    abort: (peerId: string, id: string) =>
      send<{ ok: true }>(peerId, pathOf(family.abort, id), { method: "POST" }),

    /** Rewind the transcript from a user message onward, named by its
     * timestamp. An active run is aborted first, server-side. */
    rewind: (peerId: string, id: string, timestamp: number) =>
      send<{ ok: true }>(peerId, pathOf(family.rewind, id), {
        method: "POST",
        body: JSON.stringify({ timestamp }),
      }),

    /** Answer a pending ask (the ask tool): resolves the blocked run with the
     * user's selections. */
    answer: (
      peerId: string,
      id: string,
      toolCallId: string,
      answers: AskAnswer[],
    ) =>
      send<{ ok: true }>(peerId, pathOf(family.answer, id), {
        method: "POST",
        body: JSON.stringify({ toolCallId, answers }),
      }),
  };
}
