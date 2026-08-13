import type {
  AgentMessage,
  ClientEvent,
  SessionView,
  TaskInfo,
  TaskView,
  TodoPhase,
} from "./types.ts";

/** Identity key for dedup: messages are keyed by role + timestamp (the
 * same pair used by the persisted rows). The minimal shape also accepts
 * the role+timestamp pairs carried by the messages_truncated event. */
export function messageKey(m: { role: string; timestamp: number }): string {
  return `${m.role}:${m.timestamp}`;
}

/** Drop messages whose key is in the `removed` set (rewind tombstones).
 * mergeMessages is append-only, so without this a resync would resurrect
 * messages a rewind deleted while the socket was down. */
export function filterRemoved(
  messages: AgentMessage[],
  removed: Set<string>,
): AgentMessage[] {
  if (removed.size === 0) return messages;
  return messages.filter((m) => !removed.has(messageKey(m)));
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

/** True when two todo plan snapshots are identical (ids, names, and
 * statuses). The resync replaces the whole plan, so an unchanged snapshot
 * must not trigger a view update on every sync tick. */
export function sameTodoPlan(a: TodoPhase[], b: TodoPhase[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((phase, i) => {
    const other = b[i]!;
    if (phase.id !== other.id || phase.name !== other.name) return false;
    if (phase.tasks.length !== other.tasks.length) return false;
    return phase.tasks.every((task, j) => {
      const otherTask = other.tasks[j]!;
      return task.id === otherTask.id && task.name === otherTask.name &&
        task.status === otherTask.status;
    });
  });
}

/** True when two task lists are identical (ids, types, descriptions, and
 * statuses). The resync replaces the whole list, so an unchanged snapshot
 * must not trigger a view update on every sync tick. The live response
 * text is derived state (deltas) and deliberately not compared. */
export function sameTasks(a: TaskView[], b: TaskView[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((task, i) => {
    const other = b[i]!;
    return task.agentId === other.agentId &&
      task.subagentType === other.subagentType &&
      task.description === other.description &&
      task.status === other.status;
  });
}

/** Merge the server's task snapshot into the view's task list: known tasks
 * take the snapshot's status/description (and its text when longer — the
 * snapshot is a point-in-time tail, so the live view may be ahead of it);
 * unknown tasks are appended oldest first (the snapshot is newest first). */
export function mergeTasks(
  existing: TaskView[],
  fetched: TaskInfo[],
): TaskView[] {
  const byId = new Map(fetched.map((info) => [info.agentId, info]));
  const merged = existing.map((t) => {
    const info = byId.get(t.agentId);
    if (info === undefined) return t;
    return {
      ...t,
      subagentType: info.subagentType,
      description: info.description,
      status: info.status,
      liveText: info.text.length > t.liveText.length ? info.text : t.liveText,
    };
  });
  const known = new Set(existing.map((t) => t.agentId));
  for (const info of [...fetched].reverse()) {
    if (known.has(info.agentId)) continue;
    merged.push({
      agentId: info.agentId,
      subagentType: info.subagentType,
      description: info.description,
      status: info.status,
      liveText: info.text,
    });
  }
  return merged;
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
      // any question left over from it can no longer be answered.
      return {
        ...view,
        error: undefined,
        pendingQuestions: [],
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
      return { ...view, messages: upsertMessage(view.messages, event.message) };
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
      // The ask tool resolved (answered or failed): its questions are gone.
      const pendingQuestions = view.pendingQuestions.filter(
        (q) => q.toolCallId !== event.toolCallId,
      );
      return pendingQuestions.length === view.pendingQuestions.length
        ? { ...view, runningTools }
        : { ...view, runningTools, pendingQuestions };
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
    case "session_error":
      return { ...view, error: event.message };
    case "messages_truncated": {
      // The transcript was rewound from a user message onward: drop the
      // exact messages the server removed, and tombstone their keys so an
      // append-only resync cannot resurrect them. Run state is cleared
      // too (a running run was aborted by the rewind), questions included.
      const removedKeys = new Set(event.removed.map((m) => messageKey(m)));
      const removed = new Set(view.removed);
      for (const key of removedKeys) removed.add(key);
      return {
        ...view,
        messages: view.messages.filter((m) => !removedKeys.has(messageKey(m))),
        removed,
        streamingText: "",
        runningTools: new Map(),
        pendingQuestions: [],
        error: undefined,
        agentStartedAt: undefined,
        agentEndedAt: undefined,
        thinkingStartAt: undefined,
      };
    }
    case "agent_end":
      return view.agentStartedAt === undefined ? null : {
        ...view,
        pendingQuestions: [],
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
