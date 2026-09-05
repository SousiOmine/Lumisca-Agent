import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
// Loads the declaration merge that adds NotificationMessage and
// ModeMessage to pi's AgentMessage union (see pi-augmentation.ts). Every
// importer of this module therefore sees the augmented type.
import "./pi-augmentation.ts";
import { modeFullPromptText, type ModeMessage } from "./mode-message.ts";

/** Kind of a system notification injected into an agent loop: background
 * command completions (async_bash), sub-agent task completions (task),
 * agent-to-agent messages (send_message), and empty-response retries (the
 * session agent retries a response that produced neither text nor a tool
 * call). */
export type NotificationKind = "background" | "task" | "message" | "retry";

/** Outcome of the event a notification reports. The UI shows a check for
 * success, an error badge for failure, and nothing for neutral. */
export type NotificationStatus = "success" | "error" | "neutral";

/**
 * A system notification delivered to an agent as a first-class message
 * (injected by the session agent or steered into a sub-agent). The agent
 * sees it as a user message — see toLlmMessages — whose text starts with
 * the prefix contract taught in the system prompt ("[Background command
 * ...]", "[Task ...]", "[Message from ...]"). The UI renders it as a
 * compact one-line row instead of a user message.
 */
export interface NotificationMessage {
  role: "notification";
  kind: NotificationKind;
  /** Head line shown by the UI and used as the first line of the
   * agent-visible text (e.g. "[Background command #2 finished after 12s
   * (exit code 0)]"). */
  title: string;
  /** Detail text (output tail / task result / message body); empty when
   * there is nothing beyond the title. */
  body: string;
  status: NotificationStatus;
  timestamp: number;
}

/** What the generators (background / task) produce; the session agent
 * stamps role and timestamp when injecting. */
export type NotificationPayload = Omit<
  NotificationMessage,
  "role" | "timestamp"
>;

/** The agent-visible text of a notification: the title (its "[...]" head)
 * followed by the body on the next line when present. */
export function notificationText(
  notification: NotificationMessage | NotificationPayload,
): string {
  return notification.body.length > 0
    ? `${notification.title}\n${notification.body}`
    : notification.title;
}

/** Convert agent messages to LLM messages: notification messages become
 * user messages carrying notificationText, mode messages become user
 * messages carrying the full prompt text (so the LLM sees the full
 * mode prompt), everything else passes the standard role filter (the
 * same one pi applies by default). */
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
    if (message.role === "mode") {
      const modeMsg = message as ModeMessage;
      out.push({
        role: "user",
        content: [{ type: "text", text: modeFullPromptText(modeMsg) }],
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
