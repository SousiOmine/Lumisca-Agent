/**
 * The assistant messages a run builds before (or instead of) a model answer:
 * the placeholder a turn is announced with, and the record a failed turn
 * leaves.
 *
 * Both carry no content — that emptiness is what the retry policy classifies
 * (`hasNoVisibleOutput`) — so their shape is decided here once, together with
 * the stop reason that tells the two apart.
 */

import type { AssistantMessage, StopReason } from "../domain/message.ts";
import type { Api } from "../domain/model.ts";
import type { Model } from "./catalog.ts";

/** The assistant message a turn announces itself with before its stream
 * emits anything: empty, and pending until the transport fills it in. */
export function pendingAssistant(model: Model<Api>): AssistantMessage {
  return emptyAssistant(model, "pending");
}

/** The assistant message of a turn that failed before it could answer: the
 * failure is the turn's record, so the transcript (and with it the DB, the
 * UI banner and the session log) says why it ended. */
export function failedAssistant(
  model: Model<Api>,
  errorMessage: string,
  errorRetryable = false,
): AssistantMessage {
  return {
    ...emptyAssistant(model, "error"),
    errorMessage,
    ...(errorRetryable ? { errorRetryable: true } : {}),
  };
}

function emptyAssistant(
  model: Model<Api>,
  stopReason: StopReason,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}
