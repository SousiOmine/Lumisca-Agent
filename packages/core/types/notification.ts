import type { AgentMessage, Message } from "../ai/types.ts";
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
  /** True when the notification was steered into the run that was already
   * active instead of starting its own run (see SessionAgent.deliverPrompt);
   * absent when it started its own run. The UI keeps a steered notification
   * inside that run's turn instead of starting a new one (see web's
   * buildTurns): it is a system event of the ongoing work, like a tool
   * result, so it must not split the turn — the running turn's work log
   * would collapse mid-run. */
  steered?: boolean;
  timestamp: number;
}

/** What the generators (background / task) produce; the session agent
 * stamps role, timestamp and `steered` when injecting — only the delivery
 * site knows whether the notification joins the run that is already
 * active. */
export type NotificationPayload = Omit<
  NotificationMessage,
  "role" | "timestamp" | "steered"
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

/** Convert agent messages to LLM messages: notification and context
 * messages become user messages (carrying notificationText / the context
 * body), compaction checkpoints become user messages carrying the checkpoint
 * text, mode messages become user messages carrying the full prompt text
 * (so the LLM sees the full mode prompt), everything else passes the
 * standard role filter (the same one pi applies by default). */
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
