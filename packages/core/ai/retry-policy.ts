import type { AssistantMessage } from "./types.ts";
import type { NotificationMessage } from "./types.ts";
import { isContextOverflowText } from "./context-overflow.ts";
import { notificationMessage } from "../types/notification.ts";

/** Maximum consecutive vacant responses (no text, no tool call) to retry
 * before giving up and ending the run normally. Shared by both retry
 * mechanisms — in-run vacant retries and silent-error restarts — so a
 * model that keeps failing can never loop forever. */
export const MAX_EMPTY_RESPONSE_RETRIES = 3;

/** True when the response produced nothing the user can see: no text and
 * no tool call. Thinking blocks alone don't count as output (the user
 * never sees them). */
export function hasNoVisibleOutput(message: AssistantMessage): boolean {
  return message.content.every(
    (block) =>
      block.type !== "toolCall" &&
      (block.type !== "text" || block.text.trim().length === 0),
  );
}

/** Error-message signatures of transient transport failures: streams cut
 * off mid-flight (the observed "Stream ended without finish_reason"),
 * connection resets, provider-side blips, and the AI SDK's own wrapper for
 * a body read that failed after a 2xx response ("Failed to process
 * successful response" / "Invalid JSON response" — the real cause lives in
 * the SDK's `APICallError.cause`, which the transport renders into the
 * message). Only these qualify for automatic restarts — a silent
 * PERMANENT failure (unconfigured or unauthorized provider, content
 * filter) has no chance of recovering, so it must surface immediately
 * instead of burning through the retry limit.
 *
 * Context overflow is deliberately NOT here: it is recoverable, but only by
 * shrinking the history first (see isContextOverflowError). */
const TRANSIENT_STREAM_ERROR_PATTERN =
  /without finish_reason|finish_reason: network_error|failed to process successful response|invalid json response|fetch failed|network|socket hang up|connection|terminated|premature close|timed out|\b(?:500|502|503|504|529)\b|overloaded/i;

/** True when the provider rejected the request for exceeding the model's
 * window: the wording classifier is shared with the transport (see
 * ai/context-overflow.ts), which may already have repaired the request by
 * shrinking its completion cap; the policy sees only the failures that
 * repair could not fix. This is the trigger the compactor's overflow
 * recovery hangs off: the request cannot succeed unchanged, and the only
 * remaining repair is a smaller history. */
export function isContextOverflowError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error") return false;
  return isContextOverflowText(message.errorMessage ?? "");
}

/** True when an error-stopped response failed for a transport reason that
 * may recover. The provider's own flag (`APICallError.isRetryable`, carried
 * as `message.errorRetryable`) decides first; the wording is the fallback
 * for failures the provider did not classify. */
export function isTransientStreamError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error") return false;
  if (message.errorRetryable === true) return true;
  return TRANSIENT_STREAM_ERROR_PATTERN.test(message.errorMessage ?? "");
}

/** True when the stream died before the model produced anything: an
 * error-stopped response with zero output (thinking alone doesn't count —
 * the user never sees it) whose cause looks transient. The agent loop
 * exits immediately on these turns without draining the follow-up queue,
 * so the in-run vacant-retry cannot fire; SessionAgent restarts the run
 * itself once it settles (see handleTurnEnd / resumeAfterErrorRun). An
 * unknown error message is conservatively treated as permanent. */
export function isSilentErrorResponse(message: AssistantMessage): boolean {
  return isTransientStreamError(message) && hasNoVisibleOutput(message);
}

/** The notification queued to continue a response the transport cut off
 * mid-stream. The partial text is already in the transcript, so the model
 * is told to resume rather than repeat. */
export function buildInterruptedRetryNotification(
  attempt: number,
): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Previous response was cut off (retry ${attempt})`,
    body: "Your previous response was interrupted by a transport failure. " +
      "Continue from where it stopped — do not repeat what you already wrote.",
    status: "neutral",
  });
}

/** True when the provider cut the response at the output cap: the model was
 * still talking, so the answer is incomplete even though it looks fine.
 * Treated like an interrupted stream (continue from where it stopped), with
 * its own budget: cutting an answer short is not a transport failure. */
export function isOutputCapStop(message: AssistantMessage): boolean {
  return message.stopReason === "length";
}

/** The notification queued to continue a response the provider cut at the
 * output cap. The partial text is already in the transcript. */
export function buildOutputCapRetryNotification(
  attempt: number,
): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Output limit reached (retry ${attempt})`,
    body: "Your previous response hit the model's output limit and was cut " +
      "off. Continue from where it stopped — do not repeat what you already " +
      "wrote.",
    status: "neutral",
  });
}

/** The notification queued to retry a vacant response. The text is
 * self-contained (no system-prompt prefix contract): the model reads it as
 * a user message telling it its previous response was empty. */
export function buildRetryNotification(attempt: number): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Previous response was empty (retry ${attempt})`,
    body:
      "You produced neither text nor a tool call. Continue: respond with text or call a tool.",
    status: "neutral",
  });
}

/** The notification queued to retry after a provider rate-limit (429) turn.
 * Unlike the vacant-response retry, the model was cut off by throttling, not
 * by producing nothing — so the text tells it to wait and then continue. */
export function buildRateLimitRetryNotification(
  attempt: number,
): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Rate limited by provider (retry ${attempt})`,
    body:
      "The provider returned a rate-limit error. Wait a moment, then continue: " +
      "respond with text or call a tool.",
    status: "neutral",
  });
}

/** The notification queued to restart a run whose request exceeded the
 * model's context window. The history is condensed before the restart (see
 * SessionAgent's compaction), so the retry asks the model to pick the work
 * back up from the checkpoint — the transcript it sees is the condensed
 * one, not the request that was rejected. */
export function buildContextOverflowRetryNotification(
  attempt: number,
): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Context window exceeded (retry ${attempt})`,
    body:
      "The previous request exceeded the model's context window, so older " +
      "history was condensed into a checkpoint. Continue the work from the " +
      "current state: respond with text or call a tool.",
    status: "neutral",
  });
}
