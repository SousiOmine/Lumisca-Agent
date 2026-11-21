/**
 * The retry that follows an unreadable app card.
 *
 * A reply is shown and stored only after its cards parse (see
 * shared/ui-app/check.ts). A failure is not a reply: the message is taken
 * back from the transcript before it is persisted, the client is told to drop
 * what it streamed, and the model gets the parser's own message plus the text
 * it wrote so it can rewrite the card. The budget is small because the same
 * mistake repeated is unlikely to repair itself.
 */
import type { NotificationMessage } from "../ai/message.ts";
import { notificationMessage } from "../ai/notification.ts";
import type { AppCardProblem } from "../shared/ui-app/check.ts";

/** How many times one failed card may be rewritten before the run reports
 * the failure instead. */
export const MAX_APP_CARD_RETRIES = 2;

/** The in-run instruction that asks for a corrected card. `text` is the
 * discarded reply, carried back because the transcript no longer holds it. */
export function appCardRetryNotification(
  attempt: number,
  failure: AppCardProblem,
  text: string,
): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `UI generation failed (retry ${attempt})`,
    body: [
      "Your last reply was not shown because its app card could not be parsed: " +
        `${failure.problem}.`,
      "Rewrite the whole reply with a valid `ui` card. Follow the app-ui skill exactly: " +
        "version is 1, elements is a flat map, and every element named by root or children exists. " +
        "Do not mention this failure to the user.",
      "The reply that was discarded:",
      "````",
      text,
      "````",
    ].join("\n\n"),
    status: "error",
  });
}
