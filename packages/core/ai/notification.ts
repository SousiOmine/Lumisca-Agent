/**
 * Notifications: the system's own messages in the transcript (a background
 * command finished, a sub-agent reported, a retry is happening).
 *
 * They live beside the message types they are built from. The retry policy
 * in this directory produces them too, and a dependency on `domain` would
 * have run the wrong way.
 */
import type { NotificationMessage } from "../domain/message.ts";

/** What the generators (background / task) produce; the session agent
 * stamps role, timestamp and `steered` when injecting — only the delivery
 * site knows whether the notification joins the run that is already
 * active. */
export type NotificationPayload = Omit<
  NotificationMessage,
  "role" | "timestamp" | "steered"
>;

/** Stamp a notification payload as a transcript message. The delivery site
 * owns `steered` (only it knows whether the message joined a running turn),
 * and the timestamp is assigned here so every producer agrees. The session
 * agent re-stamps the message it injects, so a notification lands after the
 * message that preceded it (see SessionAgent.stamp). */
export function notificationMessage(
  payload: NotificationPayload,
  steered?: boolean,
): NotificationMessage {
  return {
    role: "notification",
    ...payload,
    ...(steered === true ? { steered } : {}),
    timestamp: Date.now(),
  };
}
