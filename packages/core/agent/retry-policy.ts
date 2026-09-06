import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { NotificationMessage } from "../types/notification.ts";
import { notificationMessage } from "../tools/subagent-format.ts";

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

/** True when the assistant response produced neither text nor a tool call:
 * the model ended its turn without any output. Error/aborted stops are
 * handled separately (see isSilentErrorResponse and handleTurnEnd) — they
 * terminate the run instead of continuing the loop. */
export function isVacantResponse(message: AssistantMessage): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return false;
  }
  return hasNoVisibleOutput(message);
}

/** Error-message signatures of transient transport failures: streams cut
 * off mid-flight (the observed "Stream ended without finish_reason"),
 * connection resets, provider-side blips. Only these qualify for
 * automatic restarts — a silent PERMANENT failure (unconfigured or
 * unauthorized provider, content filter, context overflow) has no chance
 * of recovering, so it must surface immediately instead of burning
 * through the retry limit. */
const TRANSIENT_STREAM_ERROR_PATTERN =
  /without finish_reason|finish_reason: network_error|fetch failed|network|socket hang up|connection|terminated|premature close|timed out|\b(?:500|502|503|504|529)\b|overloaded/i;

/** True when the stream died before the model produced anything: an
 * error-stopped response with zero output (thinking alone doesn't count —
 * the user never sees it) whose cause looks transient. The agent loop
 * exits immediately on these turns without draining the follow-up queue,
 * so the in-run vacant-retry cannot fire; SessionAgent restarts the run
 * itself once it settles (see handleTurnEnd / resumeAfterErrorRun). An
 * unknown error message is conservatively treated as permanent. */
export function isSilentErrorResponse(message: AssistantMessage): boolean {
  if (message.stopReason !== "error") return false;
  if (!hasNoVisibleOutput(message)) return false;
  return TRANSIENT_STREAM_ERROR_PATTERN.test(message.errorMessage ?? "");
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
