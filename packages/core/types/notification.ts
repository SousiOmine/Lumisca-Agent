import type {
  AgentMessage,
  Message,
  ModeMessage,
  NotificationMessage,
} from "../ai/types.ts";
import { modeFullPromptText } from "./mode-message.ts";

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
 * and the timestamp is assigned here so every producer agrees. */
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

/** The agent-visible text of a notification: the title (its "[...]" head)
 * followed by the body on the next line when present. */
export function notificationText(
  notification: NotificationMessage | NotificationPayload,
): string {
  return notification.body.length > 0
    ? `${notification.title}\n${notification.body}`
    : notification.title;
}

/** Convert agent messages to LLM messages: notification and context
 * messages become user messages (carrying notificationText / the context
 * body), compaction checkpoints become user messages carrying the checkpoint
 * text, mode messages become user messages carrying the full prompt text
 * (so the LLM sees the full mode prompt) followed by the images attached
 * to it, everything else passes the standard role filter (the same one pi
 * applies by default). */
export function toLlmMessages(messages: AgentMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "notification") {
      out.push({
        role: "user",
        content: [{ type: "text", text: notificationText(message) }],
        timestamp: message.timestamp,
      });
      continue;
    }
    if (message.role === "context" || message.role === "checkpoint") {
      out.push({
        role: "user",
        content: [{ type: "text", text: message.body }],
        timestamp: message.timestamp,
      });
      continue;
    }
    if (message.role === "mode") {
      const modeMsg = message as ModeMessage;
      out.push({
        role: "user",
        content: [
          { type: "text", text: modeFullPromptText(modeMsg) },
          ...modeMsg.images,
        ],
        timestamp: message.timestamp,
      });
      continue;
    }
    if (
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult"
    ) {
      out.push(message as Message);
    }
  }
  return out;
}
