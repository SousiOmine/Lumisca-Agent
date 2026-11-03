/**
 * The handlers a code-mode session and a stella conversation share.
 *
 * Both surfaces let the user send a prompt, stop a run, answer an ask, rewind
 * and switch the model. The route prefix and how a request's id is resolved
 * differ (`/sessions/:id` finds a session row, `/stella/conversations/:agentId`
 * finds the agent's conversation); everything after that is the same call on
 * the core. Written twice, the two copies drifted in their validation and
 * their doc comments (`answer` parsed its body in one and hand-validated it in
 * the other), and a rule added to one was not added to the other.
 *
 * The builder takes the two things that vary and installs the five routes:
 *
 * - `base`: the path prefix, including the id parameter's name;
 * - `resolve`: the id from the path, checked to exist (throwing `AppError`
 *   when it does not).
 *
 * The prompt route is NOT here: a code-mode session's attachments go to the
 * user's own folders and a conversation's go into its machine, so the two
 * differ in where they put the bytes, not in their wire shape.
 */
import type { Context, Hono } from "hono";
import { type AskAnswer, parseAnswerBody } from "./session-requests.ts";
import {
  AppError,
  parseBody,
  requireBody,
  requireNonEmptyString,
  requireNumber,
} from "./util.ts";

/** What the shared handlers need from the core. */
export interface ConversationApi {
  abort(id: string): void;
  /** Open the session first: a rewind touches the live transcript, not just
   * the store. */
  openSession(id: string): unknown;
  rewind(id: string, timestamp: number): Promise<void>;
  setSessionModel(id: string, provider: string, modelId: string): void;
  answerQuestion(id: string, toolCallId: string, answers: AskAnswer[]): void;
  /** A code-mode session's model change answers the session record; a
   * conversation's answers `{ ok: true }`. The route keeps that difference,
   * because it is what each client already reads. */
  getSession(id: string): unknown;
}

export interface ConversationRoutesOptions {
  /** The path prefix, including the id parameter (`/sessions/:id`). */
  base: string;
  /** The session id a request names, or a thrown AppError when it names
   * nothing. */
  resolve(context: Context): string;
  /** What a model change answers. `session` returns the session record (a
   * code-mode tab repaints the picker from it); `ok` returns `{ ok: true }`
   * (a conversation reads its model from the next snapshot). */
  modelResponse: "session" | "ok";
}

/** Install the shared session/conversation routes on `app`. */
export function conversationRoutes(
  app: Hono,
  core: ConversationApi,
  options: ConversationRoutesOptions,
): void {
  const path = (suffix: string) => `${options.base}${suffix}`;

  /** Stop the run. A no-op that still answers `ok` when nothing is running:
   * the button is also how a client recovers from a stream it lost. */
  app.post(path("/abort"), (c) => {
    core.abort(options.resolve(c));
    return c.json({ ok: true });
  });

  /** Answer a pending ask (the ask tool): resolves the blocked run with the
   * user's answers. Throws 404 when the ask is gone (already answered, or
   * the run was aborted/rewound), 400 for malformed or mismatched answers. */
  app.post(path("/answer"), async (c) => {
    const body = await parseBody<unknown>(c);
    const { toolCallId, answers } = parseAnswerBody(body);
    core.answerQuestion(options.resolve(c), toolCallId, answers);
    return c.json({ ok: true });
  });

  /** Rewind the transcript from a user message onward (deletes that message
   * and everything after it; an active run is aborted first). The request
   * resolves once the truncation is complete, so the client can restore the
   * rewound text to the composer. */
  app.post(path("/rewind"), async (c) => {
    const body = await parseBody<{ timestamp?: unknown }>(c);
    const timestamp = requireNumber(body?.timestamp, "timestamp (number)");
    const id = options.resolve(c);
    await core.openSession(id);
    await core.rewind(id, timestamp);
    return c.json({ ok: true });
  });

  /** Switch the model the session runs on. */
  app.post(path("/model"), async (c) => {
    const body = requireBody(
      await parseBody<{ provider?: unknown; modelId?: unknown }>(c),
    );
    // Trimmed before the emptiness check: a body of {"provider": "  "}
    // describes the request, so it is a 400 here rather than an id no catalog
    // has, which the core would refuse with a confusing 404.
    const provider = requireNonEmptyString(body.provider, "provider").trim();
    const modelId = requireNonEmptyString(body.modelId, "modelId").trim();
    if (provider === "" || modelId === "") {
      throw new AppError("provider and modelId must not be blank", 400);
    }
    const id = options.resolve(c);
    core.setSessionModel(id, provider, modelId);
    return options.modelResponse === "session"
      ? c.json(core.getSession(id))
      : c.json({ ok: true });
  });
}

/** Throw the 404 a route owes when an id names nothing (kept out of the
 * per-surface resolvers so both say it the same way). */
export function notFound(what: string, id: string): AppError {
  return new AppError(`${what} not found: ${id}`, 404);
}
