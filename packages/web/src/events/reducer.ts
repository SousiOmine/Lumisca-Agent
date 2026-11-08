import {
  addContextUsage,
  subtractContextUsage,
  withLatestContextUsage,
} from "@lumisca/core/shared";
import type {
  AgentMessage,
  ClientEvent,
  SessionView,
  ToolCallBlock,
} from "../types.ts";
import { messageKey } from "./identity.ts";
import { sameGoal } from "./equality.ts";

/** Whether a filter kept the message the history started at (the cursor names
 * that message, so it stays true exactly as long as it survives). */
function keepsFront(
  before: readonly AgentMessage[],
  after: readonly AgentMessage[],
): boolean {
  const front = before[0];
  const next = after[0];
  return front !== undefined && next !== undefined &&
    messageKey(front) === messageKey(next);
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

/**
 * Apply one live message to a view: the stream's copy, in its transcript
 * place.
 *
 * A message the view already holds is replaced by this copy. A message it does
 * not hold is appended — the view always ends at the transcript's end, so a
 * live message arrives after what it has — *unless* it is older than the
 * view's newest message. That case is one the view cannot draw: the message
 * belongs to a window the reader has not loaded (a steered prompt, a tool
 * result of an older turn, the checkpoint a compaction spliced into the
 * history). Dropping it keeps the loaded window contiguous, and the reader
 * reaches it by paging back or by a snapshot that carries it.
 *
 * The context meter follows the message: the summary the server sent
 * describes the whole transcript, and a turn that was just priced must move
 * the meter now, not at the next resync.
 */
function applyMessage(
  view: SessionView,
  message: AgentMessage,
): SessionView | null {
  const previous = view.messages.find((m) =>
    messageKey(m) === messageKey(message)
  );
  if (previous === undefined && isOlderThanLoaded(view.messages, message)) {
    return null;
  }
  const usage = addContextUsage(
    previous === undefined
      ? view.usage
      : subtractContextUsage(view.usage, previous),
    message,
  );
  return { ...view, messages: upsertMessage(view.messages, message), usage };
}

/** The tool calls an assistant message carries, in the order the model wrote
 * them. Those are the transcript's own rows for the calls, and the ones a
 * live row is replaced by. */
function toolCallsOf(message: AgentMessage): ToolCallBlock[] {
  if (message.role !== "assistant") return [];
  return message.content.filter(
    (block): block is ToolCallBlock => block.type === "toolCall",
  );
}

/** Whether the loaded window already draws `toolCallId`. The faux transport
 * runs a step's tool calls AFTER announcing the assistant message (the SDK
 * executes them inside the stream, a test double does not), so its
 * `tool_start` follows the row it belongs to; a second row would draw the
 * same call twice. */
function holdsToolCall(
  messages: readonly AgentMessage[],
  toolCallId: string,
): boolean {
  return messages.some((message) =>
    toolCallsOf(message).some((call) => call.id === toolCallId)
  );
}

/** `args` travel as `unknown` (the event's wire type); a tool line reads a
 * record. */
function toolArguments(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

/** The live rows with a call added, or refreshed when the same call is
 * announced twice (the SDK's execution and the fallback both reporting it).
 * The returned array is the old one when nothing changed. */
function withLiveTool(
  liveTools: ToolCallBlock[],
  call: ToolCallBlock,
): ToolCallBlock[] {
  const index = liveTools.findIndex((tool) => tool.id === call.id);
  if (index === -1) return [...liveTools, call];
  const next = [...liveTools];
  next[index] = call;
  return next;
}

/** The live rows minus the calls the arriving message now draws itself. */
function withoutToolCalls(
  liveTools: ToolCallBlock[],
  message: AgentMessage,
): ToolCallBlock[] {
  const calls = toolCallsOf(message);
  if (calls.length === 0) return liveTools;
  const replaced = new Set(calls.map((call) => call.id));
  return liveTools.some((tool) => replaced.has(tool.id))
    ? liveTools.filter((tool) => !replaced.has(tool.id))
    : liveTools;
}

/** Whether `message` belongs before the newest message the view holds. A
 * timestamp comparison is what the transcript's order is: messages are
 * stamped when they are created, and the view always holds the last one. */
function isOlderThanLoaded(
  messages: readonly AgentMessage[],
  message: AgentMessage,
): boolean {
  const newest = messages.at(-1);
  return newest !== undefined && message.timestamp < newest.timestamp;
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
      // A new run starts: a stale error from the previous run is gone, and
      // any question left over from it can no longer be answered. A live
      // tool row from a run that ended without its message is not this
      // run's either.
      return {
        ...view,
        error: undefined,
        pendingQuestions: [],
        liveTools: [],
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
          thinkingStartAt: hasThinking
            ? (view.thinkingStartAt ?? Date.now())
            : undefined,
        };
      }
      // User messages are not rendered optimistically; the stream is the
      // only source. Upsert (not append): a message sent while the agent is
      // running is announced immediately by the server and re-emitted when
      // the run drains it — same role + timestamp — so it must never show
      // twice.
      return applyMessage(view, event.message);
    }
    case "message_delta":
      // Bound the streaming buffer like task_delta: the server keeps only
      // the tail anyway, and message_end replaces the stream with the
      // complete message, so truncating the tail is never visible in the
      // final render.
      return {
        ...view,
        streamingText: (view.streamingText + event.delta).slice(-64 * 1024),
      };
    case "message_end": {
      // The user message was already added on message_start; replace it
      // with the final copy (append when the start event was missed).
      // Assistant messages get the same treatment so a resync race cannot
      // append a duplicate.
      // The calls the message carries are drawn from it from now on, so
      // their live rows go (see tool_start).
      const liveTools = withoutToolCalls(view.liveTools, event.message);
      // Clear thinking indicator once the message is complete.
      const applied = applyMessage(view, event.message);
      if (applied === null) {
        // The message belongs to a window this view does not hold, but its
        // calls just left the live rows: leaving them would draw a call the
        // transcript already has.
        return liveTools === view.liveTools ? null : { ...view, liveTools };
      }
      return {
        ...applied,
        streamingText: "",
        thinkingStartAt: undefined,
        liveTools,
      };
    }
    case "tool_start": {
      // The run is executing this call now. Its assistant message arrives
      // only when the step ends, which is after the tool returned, so the
      // row is drawn from here until that message replaces it.
      const runningTools = new Map(view.runningTools);
      runningTools.set(event.toolCallId, event.toolName);
      const liveTools = holdsToolCall(view.messages, event.toolCallId)
        ? view.liveTools
        : withLiveTool(view.liveTools, {
          type: "toolCall",
          id: event.toolCallId,
          name: event.toolName,
          arguments: toolArguments(event.args),
        });
      return { ...view, runningTools, liveTools };
    }
    case "tool_end": {
      const runningTools = new Map(view.runningTools);
      runningTools.delete(event.toolCallId);
      // The ask tool resolved (answered or failed): its questions are gone.
      const pendingQuestions = view.pendingQuestions.filter(
        (q) => q.toolCallId !== event.toolCallId,
      );
      // The call is complete, so the card it was writing is final from now
      // on (it arrives with the tool result).
      const liveCard = view.liveCard?.toolCallId === event.toolCallId
        ? null
        : view.liveCard;
      return pendingQuestions.length === view.pendingQuestions.length &&
          liveCard === view.liveCard
        ? { ...view, runningTools }
        : { ...view, runningTools, pendingQuestions, liveCard };
    }
    case "card_delta": {
      // A card being written into a tool call: the screen draws what has
      // arrived (see Transcript), and the tool result replaces it.
      const markup = view.liveCard?.toolCallId === event.toolCallId
        ? view.liveCard.markup + event.delta
        : event.delta;
      return {
        ...view,
        liveCard: { toolCallId: event.toolCallId, markup },
      };
    }
    case "question": {
      // The agent asked the user a question; show it above the composer.
      // Dedup by tool call id: a resync could re-deliver the event.
      if (
        view.pendingQuestions.some((q) => q.toolCallId === event.toolCallId)
      ) {
        return view;
      }
      return {
        ...view,
        pendingQuestions: [
          ...view.pendingQuestions,
          { toolCallId: event.toolCallId, questions: event.questions },
        ],
      };
    }
    case "todo": {
      // The todo plan changed; the event carries the full snapshot, so a
      // resync that re-delivers it converges to the same state.
      return { ...view, todos: event.todos };
    }
    case "task_start": {
      // A sub-agent started (the task tool). Dedup by agent id: a resync
      // could re-deliver the event.
      if (view.tasks.some((t) => t.agentId === event.agentId)) return view;
      return {
        ...view,
        tasks: [
          ...view.tasks,
          {
            agentId: event.agentId,
            subagentType: event.subagentType,
            description: event.description,
            status: "running",
            liveText: "",
          },
        ],
      };
    }
    case "task_delta": {
      // A chunk of a sub-agent's live response; append to the task's view
      // (bounded, the server keeps only the tail anyway).
      const tasks = view.tasks.map((t) => {
        if (t.agentId !== event.agentId) return t;
        return { ...t, liveText: (t.liveText + event.delta).slice(-8192) };
      });
      return { ...view, tasks };
    }
    case "task_end": {
      // A sub-agent settled; the panel shows its final status.
      const tasks = view.tasks.map((t) =>
        t.agentId === event.agentId ? { ...t, status: event.status } : t
      );
      return { ...view, tasks };
    }
    case "background_start": {
      // A background command started (the async_bash tool). Dedup by
      // command id: a resync could re-deliver the event.
      if (view.backgrounds.some((b) => b.commandId === event.commandId)) {
        return view;
      }
      return {
        ...view,
        backgrounds: [
          ...view.backgrounds,
          {
            commandId: event.commandId,
            pid: event.pid,
            command: event.command,
            cwd: event.cwd,
            state: "running",
            startedAt: event.startedAt,
            tail: "",
            liveText: "",
          },
        ],
      };
    }
    case "background_delta": {
      // A chunk of a background command's decoded output; append to the
      // command's view (bounded, the server keeps only the tail anyway).
      const backgrounds = view.backgrounds.map((b) => {
        if (b.commandId !== event.commandId) return b;
        return { ...b, liveText: (b.liveText + event.delta).slice(-8192) };
      });
      return { ...view, backgrounds };
    }
    case "background_end": {
      // A background command settled; the panel shows its final state. The
      // event's tail is the authoritative output (a resync snapshot may be
      // behind the live view), so it replaces the accumulated text when
      // longer.
      const backgrounds = view.backgrounds.map((b) =>
        b.commandId !== event.commandId ? b : {
          ...b,
          state: event.state,
          exitCode: event.exitCode,
          finishedAt: event.finishedAt,
          tail: event.tail,
          liveText: event.tail.length > b.liveText.length
            ? event.tail
            : b.liveText,
        }
      );
      return { ...view, backgrounds };
    }
    case "session_error":
      return { ...view, error: event.message };
    case "goal_start":
    case "goal_progress": {
      // The goal snapshot changed; the event carries the full snapshot,
      // so a resync that re-delivers it converges to the same state.
      return sameGoal(view.goal, event.goal)
        ? view
        : { ...view, goal: event.goal };
    }
    case "goal_done": {
      // The goal finished (achieved, capped, cancelled, or errored): the
      // panel clears. The outcome itself lands in the chat as the final
      // assistant message or a session_error, so no text is kept here.
      return view.goal === undefined ? view : { ...view, goal: undefined };
    }
    case "messages_truncated": {
      // The transcript was rewound from a user message onward: drop the
      // exact messages the server removed, and tombstone their identities so
      // a resync window cannot resurrect them. Run state is cleared too (a
      // running run was aborted by the rewind), questions included. The
      // context meter drops what the removed turns priced: the snapshot the
      // next resync reads recounts the transcript anyway.
      const removedKeys = new Set(event.removed.map((m) => messageKey(m)));
      const removed = new Set(view.removed);
      for (const key of removedKeys) removed.add(key);
      const messages: AgentMessage[] = [];
      let usage = view.usage;
      for (const message of view.messages) {
        if (removedKeys.has(messageKey(message))) {
          usage = subtractContextUsage(usage, message);
          continue;
        }
        messages.push(message);
      }
      return {
        ...view,
        messages,
        // The cursor names the oldest loaded message: it stays true while
        // that message survived, and there is nothing to name when the
        // rewind removed it (the next snapshot restores one).
        older: keepsFront(view.messages, messages) ? view.older : null,
        usage: withLatestContextUsage(usage, messages),
        removed,
        streamingText: "",
        liveTools: [],
        runningTools: new Map(),
        pendingQuestions: [],
        error: undefined,
        agentStartedAt: undefined,
        agentEndedAt: undefined,
        thinkingStartAt: undefined,
      };
    }
    case "messages_checkpoint": {
      // Older history was condensed into a checkpoint (the run keeps
      // streaming, so no run state is touched). Nothing was deleted: the
      // checkpoint is inserted at `event.index`, the position of the first
      // message the model still sees verbatim.
      //
      // The view holds a WINDOW, so the row goes in front of the message the
      // server named (`before`). When that message is not in the window, the
      // checkpoint belongs to history the reader has not loaded: drawing it
      // would put a "summarized" row above messages it does not summarize, so
      // it is dropped here. Paging back reaches it in place, and so does the
      // next snapshot.
      const existing = view.messages.findIndex((m) =>
        messageKey(m) === messageKey(event.message)
      );
      if (existing !== -1) return null;
      const anchor = view.messages.findIndex((m) =>
        messageKey(m) === messageKey(event.before)
      );
      if (anchor === -1) return null;
      const messages = [...view.messages];
      messages.splice(anchor, 0, event.message);
      return {
        ...view,
        messages,
        usage: addContextUsage(view.usage, event.message),
      };
    }
    case "agent_end":
      // The run ended (a stop may leave a call that never reported its end):
      // nothing is live any more.
      return view.agentStartedAt === undefined && view.liveCard === null &&
          view.liveTools.length === 0
        ? null
        : {
          ...view,
          pendingQuestions: [],
          liveCard: null,
          liveTools: [],
          agentEndedAt: Date.now(),
        };
    case "session_renamed":
      // The session title changed (e.g. auto-generated from the first
      // message); the tab shows the new name.
      return view.info.name === event.name
        ? null
        : { ...view, info: { ...view.info, name: event.name } };
    default:
      return null;
  }
}
