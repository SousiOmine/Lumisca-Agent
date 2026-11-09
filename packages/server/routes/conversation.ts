/**
 * The handlers a code-mode session and a stella conversation share.
 *
 * Both surfaces let the user send a prompt, stop a run, answer an ask and
 * rewind. Switching the model is code mode's alone: a stella conversation's
 * model belongs to its agent (see ConversationRoutesOptions.modelRoute). The
 * route prefix and how a request's id is resolved differ (`/sessions/:id`
 * finds a session row, `/stella/conversations/:agentId` finds the agent's
 * conversation); everything after that is the same call on the core. Written
 * twice, the two copies drifted in their validation and their doc comments
 * (`answer` parsed its body in one and hand-validated it in the other), and a
 * rule added to one was not added to the other.
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
  /** Read by the `/model` route, which only a code-mode session mounts (see
   * ConversationRoutesOptions.modelRoute). */
  setSessionModel(id: string, provider: string, modelId: string): void;
  answerQuestion(id: string, toolCallId: string, answers: AskAnswer[]): void;
  /** What a model change answers with: the session record, which a code-mode
   * tab repaints its picker from. */
  getSession(id: string): unknown;
}

export interface ConversationRoutesOptions {
  /** The path prefix, including the id parameter (`/sessions/:id`). */
  base: string;
  /** The session id a request names, or a thrown AppError when it names
   * nothing. */
  resolve(context: Context): string;
  /** Whether to install the `/model` route. A code-mode session answers its
   * session record (the tab repaints the picker from it). A stella
   * conversation does not install it: its model is the AGENT's choice, set in
   * the agent edit dialog (PATCH /stella/agents/:id), which moves the
   * conversation row in the same call — a second route writing that row would
   * leave the two disagreeing. */
  modelRoute: boolean;
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

  /** Switch the model the session runs on (code mode only — see
   * modelRoute). A run in flight is not refused: the choice is stored and the
   * agent follows it once that run ends (SessionService.setSessionModel), so
   * the answer is the session record with the new model — what the next run
   * will use. */
  if (options.modelRoute) {
    app.post(path("/model"), async (c) => {
      const body = requireBody(
        await parseBody<{ provider?: unknown; modelId?: unknown }>(c),
      );
      // Trimmed before the emptiness check: a body of {"provider": "  "}
      // describes the request, so it is a 400 here rather than an id no
      // catalog has, which the core would refuse with a confusing 404.
      const provider = requireNonEmptyString(body.provider, "provider").trim();
      const modelId = requireNonEmptyString(body.modelId, "modelId").trim();
      if (provider === "" || modelId === "") {
        throw new AppError("provider and modelId must not be blank", 400);
      }
      const id = options.resolve(c);
      core.setSessionModel(id, provider, modelId);
      return c.json(core.getSession(id));
    });
  }
}

/** Throw the 404 a route owes when an id names nothing (kept out of the
 * per-surface resolvers so both say it the same way). */
export function notFound(what: string, id: string): AppError {
  return new AppError(`${what} not found: ${id}`, 404);
}
