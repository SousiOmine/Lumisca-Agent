import type { AgentMessage, ClientEvent, SessionView } from "./types.ts";

/** Identity key for dedup: messages are keyed by role + timestamp (the
 * same pair used by the persisted rows). */
function messageKey(m: AgentMessage): string {
  return `${m.role}:${m.timestamp}`;
}

/** Merge fetched (persisted) messages into the current list without
 * duplicating anything already present. Used by resync: events emitted
 * while the socket was down arrive here after the fetch, so the merged
 * result must be idempotent. */
export function mergeMessages(
  existing: AgentMessage[],
  fetched: AgentMessage[],
): AgentMessage[] {
  const merged = [...existing];
  const seen = new Set(existing.map(messageKey));
  for (const m of fetched) {
    const key = messageKey(m);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(m);
    }
  }
  return merged;
}

/** Insert or replace a message at its existing position (dedup by key);
 * appends when absent. A resync can fetch a message whose message_end
 * event still arrives afterwards — the second copy must not duplicate. */
function upsertMessage(
  messages: AgentMessage[],
  message: AgentMessage,
): AgentMessage[] {
  const key = messageKey(message);
  const index = messages.findIndex((m) => messageKey(m) === key);
  if (index === -1) return [...messages, message];
  if (messages[index] === message) return messages;
  const next = [...messages];
  next[index] = message;
  return next;
}

/** Apply one client event to a session view. Pure: returns the updated
 * view or null when the event does not apply (wrong session / no-op /
 * not a view event). */
export function applyEvent(
  event: ClientEvent,
  view: SessionView,
): SessionView | null {
  if (event.type === "session_created") return null;
  if (!("sessionId" in event)) return null;
  if (event.sessionId !== view.info.id) return null;
  switch (event.type) {
    case "agent_start":
      // A new run starts: a stale error from the previous run is gone.
      return {
        ...view,
        error: undefined,
        agentStartedAt: Date.now(),
        agentEndedAt: undefined,
        thinkingStartAt: undefined,
      };
    case "message_start": {
      if (event.message.role === "assistant") {
        // Detect thinking: the assistant message starts with thinking content.
        const hasThinking = event.message.content.some(
          (b) => b.type === "thinking",
        );
        return {
          ...view,
          streamingText: "",
          thinkingStartAt: hasThinking ? (view.thinkingStartAt ?? Date.now()) : undefined,
        };
      }
      // User messages are not rendered optimistically; the stream is the
      // only source, so this is always an append.
      return { ...view, messages: [...view.messages, event.message] };
    }
    case "message_delta":
      return { ...view, streamingText: view.streamingText + event.delta };
    case "message_end": {
      // The user message was already added on message_start; replace it
      // with the final copy (append when the start event was missed).
      // Assistant messages get the same treatment so a resync race cannot
      // append a duplicate.
      // Clear thinking indicator once the message is complete.
      return {
        ...view,
        messages: upsertMessage(view.messages, event.message),
        streamingText: "",
        thinkingStartAt: undefined,
      };
    }
    case "tool_start": {
      const runningTools = new Map(view.runningTools);
      runningTools.set(event.toolCallId, event.toolName);
      return { ...view, runningTools };
    }
    case "tool_end": {
      const runningTools = new Map(view.runningTools);
      runningTools.delete(event.toolCallId);
      return { ...view, runningTools };
    }
    case "session_error":
      return { ...view, error: event.message };
    case "agent_end":
      return { ...view, agentEndedAt: Date.now() };
    default:
      return null;
  }
}
