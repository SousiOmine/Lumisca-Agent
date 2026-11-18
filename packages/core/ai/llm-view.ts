/**
 * The transcript as the model reads it.
 *
 * This is the default `convertToLlm` for every session and sub-agent:
 *
 * - notification and context messages become user messages carrying their
 *   text;
 * - compaction checkpoints become user messages carrying the checkpoint;
 * - mode messages become user messages carrying the FULL prompt, followed by
 *   the images attached to it;
 * - a reduced row (see session/prune.ts) is skipped whole, so a dropped tool
 *   call never leaves its result behind (providers reject an unanswered
 *   call, and the reverse);
 * - everything else passes the standard role filter.
 *
 * It lives in `ai/` because it is part of the model boundary, not a domain
 * rule: `ai` used to import it from `domain`, which made the dependency run
 * backwards.
 */

import type {
  AgentMessage,
  Message,
  ModeMessage,
  NotificationMessage,
} from "./message.ts";
import { isPruned } from "./pruned.ts";

/** The agent-visible text of a notification: the title (its "[...]" head)
 * followed by the body on the next line when present. */
export function notificationText(
  notification:
    | NotificationMessage
    | Omit<NotificationMessage, "role" | "timestamp" | "steered">,
): string {
  return notification.body.length > 0
    ? `${notification.title}\n${notification.body}`
    : notification.title;
}

export function toLlmMessages(messages: AgentMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (isPruned(message)) continue;
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
          { type: "text", text: modeMsg.fullPrompt },
          ...modeMsg.images,
        ],
        timestamp: message.timestamp,
      });
      continue;
    }
    if (message.role === "user") {
      // The model is sent what it was meant to read (see
      // UserMessage.modelContent): the visible text and the request can
      // differ — a file notice that the user never wrote, or a prompt whose
      // visible text is empty because it is only files.
      const modelContent = message.modelContent;
      if (modelContent === undefined) {
        out.push(message);
      } else {
        // `modelContent` replaces the TEXT, not the message: a prompt that
        // carried pictures keeps them.
        const images = Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "image")
          : [];
        out.push({
          ...message,
          content:
            images.length === 0
              ? modelContent
              : [{ type: "text", text: modelContent }, ...images],
        });
      }
      continue;
    }
    if (message.role === "assistant" || message.role === "toolResult") {
      out.push(message as Message);
    }
  }
  return out;
}
