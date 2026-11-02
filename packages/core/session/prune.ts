import type {
  AgentMessage,
  AssistantMessage,
  ContextMessage,
  NotificationMessage,
  ToolResultMessage,
} from "../ai/types.ts";
import { TOOL_CHAT_ATTACH } from "../shared/tool-names.ts";

/**
 * Dropping what a condensed conversation no longer needs.
 *
 * stella's premise is one conversation with one agent for years. Its
 * transcript therefore holds the work as well as the talk: tool calls, their
 * output, screenshots, the dynamic contexts that steered each run. Once a
 * compaction checkpoint has summarized a span, none of that is read again —
 * the model sees the checkpoint onward (see ai/context-compaction.ts), a
 * client never receives any of it (see agent/stella-stream.ts), and
 * `history_search` searches the conversation's entries, which are the user's
 * words and the agent's words (see session/history.ts).
 *
 * So the rule is one rule: **keep what the conversation shows, drop the
 * rest.** A row is not deleted — `insertAt` and `deleteFrom` rely on rowid
 * order being transcript order, and a hole would move every position after
 * it — it is replaced by a stub that says what it was.
 *
 * What survives, and why:
 *
 * - `user` and `mode` messages, whole. They are the person's words, and the
 *   pictures attached to them.
 * - `assistant` text, whole. It is the agent's words.
 * - the `chat_attach` result: the files were part of the reply, and a client
 *   redraws a card from the row after a reload.
 * - `checkpoint`: the summary IS the memory of everything before it.
 * - the `thinking` block, EMPTY. A model whose metadata says it needs
 *   `reasoning_content` replayed refuses a history that omits it, and an
 *   empty block satisfies the shape at no token cost (see the transport's
 *   requiresReasoningContentOnAssistantMessages).
 *
 * Everything else becomes a marker: tool calls (with their arguments, which
 * for `write`/`edit` are whole files), tool results (a screenshot is up to
 * 16 MiB of base64), notifications and context publications.
 *
 * A marker is written so the model can still read the transcript after a
 * rewind puts it back in view: it says the work happened and that its detail
 * is gone, rather than leaving a hole that reads as a gap in the record.
 */

/** The text that replaces a dropped row's content. Kept short — a marker is
 * what a long conversation pays for what it keeps. */
export const PRUNED_TOOL_CALL =
  "[pruned] The tool call and its arguments were dropped when this part of " +
  "the conversation was condensed. Only the conversation itself (what was " +
  "said) is kept.";

export const PRUNED_TOOL_RESULT =
  "[pruned] This tool output was dropped when this part of the conversation " +
  "was condensed. Re-run the command when you need its result again.";

export const PRUNED_CONTEXT =
  "[pruned] This context publication was dropped when this part of the " +
  "conversation was condensed.";

/** How a marker is recognised without a schema column: every one starts with
 * this token. */
export const PRUNED_MARKER = "[pruned]";

/** Whether a text block is one of this module's markers. */
export function isPrunedText(text: string): boolean {
  return text.startsWith(PRUNED_MARKER);
}

/** Whether a message was already reduced. */
export function isPruned(message: AgentMessage): boolean {
  switch (message.role) {
    case "assistant":
      // A reduced turn holds no calls (they became one text marker).
      return !message.content.some((block) => block.type === "toolCall") &&
        message.content.some((block) =>
          block.type === "text" && isPrunedText(block.text)
        );
    case "toolResult":
      return message.content.length > 0 &&
        message.content.every((block) =>
          block.type === "text" && isPrunedText(block.text)
        );
    case "context":
    case "notification":
      return isPrunedText(message.body);
    default:
      return false;
  }
}

/** The result of reducing one message. */
export interface PruneResult {
  message: AgentMessage;
  /** False when the message was already minimal (nothing to write back). */
  changed: boolean;
}

/**
 * Reduce one message behind a checkpoint. Messages the conversation shows
 * are returned unchanged; the rest lose their payload.
 */
export function reduceMessage(message: AgentMessage): PruneResult {
  switch (message.role) {
    case "assistant":
      return reduceAssistant(message);
    case "toolResult":
      return reduceToolResult(message);
    case "context":
      return reduceBody(message);
    case "notification":
      return reduceNotification(message);
    default:
      // user, mode, checkpoint: the conversation's own content.
      return { message, changed: false };
  }
}

function reduceAssistant(message: AssistantMessage): PruneResult {
  const kept: AssistantMessage["content"] = [];
  let changed = false;
  for (const block of message.content) {
    if (block.type === "toolCall") {
      // The calls are dropped as a group: a call whose arguments are gone
      // would still make the provider expect a result. One marker records
      // that the turn DID call something.
      changed = true;
      continue;
    }
    if (block.type === "thinking") {
      if (block.thinking !== "") {
        // Emptied, not removed: see the module comment.
        kept.push({ ...block, thinking: "" });
        changed = true;
      } else {
        kept.push(block);
      }
      continue;
    }
    kept.push(block);
  }
  if (!changed) return { message, changed: false };
  if (message.content.some((block) => block.type === "toolCall")) {
    kept.push({ type: "text", text: PRUNED_TOOL_CALL });
  }
  // A turn that held nothing but calls and thinking would now be empty,
  // which providers reject; the marker above is its content.
  return {
    message: { ...message, content: kept },
    changed: true,
  };
}

function reduceToolResult(message: ToolResultMessage): PruneResult {
  if (message.toolName === TOOL_CHAT_ATTACH && !message.isError) {
    // The files an agent handed over are part of what it said: a client
    // redraws the card from this row after a reload.
    return { message, changed: false };
  }
  if (isPruned(message)) return { message, changed: false };
  return {
    message: {
      ...message,
      content: [{ type: "text", text: PRUNED_TOOL_RESULT }],
      // `details` can hold a whole listing or a diff stat; the card that
      // would read it is gone with the output.
      details: undefined,
    },
    changed: true,
  };
}

function reduceBody(message: ContextMessage): PruneResult {
  if (isPruned(message)) return { message, changed: false };
  return {
    message: {
      ...message,
      title: message.title,
      body: PRUNED_CONTEXT,
      // The state is a hash/version the provider compares against; the
      // publication it described is gone, so the state cannot re-anchor
      // anything.
      state: undefined,
    },
    changed: true,
  };
}

function reduceNotification(message: NotificationMessage): PruneResult {
  if (isPruned(message)) return { message, changed: false };
  return {
    message: { ...message, body: PRUNED_CONTEXT },
    changed: true,
  };
}
