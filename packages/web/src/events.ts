import { isViewRunning } from "./types.ts";
import type {
  AgentMessage,
  BackgroundCommandInfo,
  BackgroundView,
  ClientEvent,
  GoalInfo,
  PendingQuestion,
  SessionView,
  TaskInfo,
  TaskView,
  TodoPhase,
} from "./types.ts";
import type { SessionSnapshot } from "./api-local.ts";

/** Identity key for dedup: messages are keyed by role + timestamp (the
 * same pair used by the persisted rows), except tool results, which are
 * keyed by their tool call id instead — a turn's parallel tool calls can
 * finish within the same millisecond, and a shared timestamp would make
 * the live upsert replace one of them and the resync merge skip it for
 * good (a message is never re-added once its key is known). The minimal
 * shape also accepts the entries carried by the messages_truncated event,
 * which name the same fields. */
export function messageKey(
  m: { role: string; timestamp: number; toolCallId?: unknown },
): string {
  if (m.role === "toolResult" && typeof m.toolCallId === "string") {
    return `${m.role}:${m.toolCallId}`;
  }
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

/** Reconcile a view's run state with the transcript snapshot's `running`
 * flag (`GET /sessions/:id/messages`; see api-local's SessionSnapshot).
 * The events are the live source of the run state, but they are never
 * replayed: a view that (re)connects while a run is going — a page load, a
 * WS drop, a tab reopened on this session — never saw its `agent_start`,
 * and without this the live run would render as finished (work log
 * collapsed under 作業完了). The server reads the flag with the transcript,
 * so the two always describe the same instant.
 *
 * Only a disagreement writes: a view that already agrees keeps its
 * identity (the periodic sync must not re-render every tab) and a finished
 * run keeps the end time its `agent_end` stamped. */
export function applyRunState(
  view: SessionView,
  running: boolean,
): SessionView {
  if (running === isViewRunning(view)) return view;
  if (!running) {
    // The run ended while this view was not listening. Its `agent_end` is
    // not replayed, so drop the stale run state: the transcript's own
    // timestamps carry the finished run's duration (see
    // ChatView/ConversationTurn).
    return {
      ...view,
      agentStartedAt: undefined,
      agentEndedAt: undefined,
    };
  }
  // A run is active and this view never saw it start. `agentStartedAt` is
  // a flag for the UI (every displayed timer is derived from the
  // transcript's messages), so the moment this view learned about the run
  // is the honest value.
  return {
    ...view,
    agentStartedAt: Date.now(),
    agentEndedAt: undefined,
  };
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

/** True when two pending-question lists are identical: the same asks in the
 * same order. A pending ask's questions never change (they are fixed when
 * the tool asks), so the tool call ids are the whole identity — the resync
 * replaces the list and must not re-render a tab whose asks are unchanged. */
export function sameQuestions(
  a: PendingQuestion[],
  b: PendingQuestion[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry.toolCallId === b[i]!.toolCallId);
}

/** Whether an event's revision skips past what this view has seen: the
 * stream is ordered and reliable while it is up, so a count that jumps
 * means frames were lost (a socket that died without a close event, a
 * peer's relay gap) and the view must re-read its snapshot. `known`
 * undefined means nothing was seen yet for that session (its first event
 * only seeds the marker: nothing was expected before it), and a count that
 * does not advance (a duplicate delivery) is not a gap. */
export function revisionGap(known: number | undefined, rev: number): boolean {
  return known !== undefined && rev > known + 1;
}

/** The fetched snapshots of one session, as the resync collects them. Any
 * piece may be missing (its request failed); the rest are still applied. */
export interface SnapshotParts {
  snapshot?: SessionSnapshot;
  todos?: TodoPhase[];
  tasks?: TaskInfo[];
  backgrounds?: BackgroundCommandInfo[];
  goal?: GoalInfo | null;
}

/** A view's live state (run state, questions, error, title) as it stood
 * when a resync fetch started. An event that changes a piece while the
 * fetch is in flight is newer than the snapshot it raced, so the piece must
 * not be overwritten by it. */
export interface LiveStateBefore {
  started: number | undefined;
  ended: number | undefined;
  questions: PendingQuestion[];
  error: string | undefined;
  name: string;
}

/** Apply fetched snapshots to a view. Returns the same view when nothing
 * changed — the resync must not re-render a tab that is already in sync.
 *
 * The pieces split in two kinds:
 * - live state (run state, pending questions, last error, title) travels
 *   with the transcript snapshot and is applied only when no event changed
 *   it meanwhile (see LiveStateBefore);
 * - panels are their own fetches: the todo plan replaces the view's plan
 *   wholesale (its events only fire on mutations), tasks and background
 *   commands merge per id so live deltas are preserved, and the goal
 *   replaces the snapshot.
 * Messages merge append-only, minus the rewind tombstones: a message
 * deleted while the socket was down must not come back. */
export function applySnapshot(
  view: SessionView,
  parts: SnapshotParts,
  before: LiveStateBefore | undefined,
): SessionView {
  const { snapshot } = parts;
  const movedByEvent = {
    runState: before !== undefined &&
      (view.agentStartedAt !== before.started ||
        view.agentEndedAt !== before.ended),
    questions: before !== undefined &&
      view.pendingQuestions !== before.questions,
    error: before !== undefined && view.error !== before.error,
    name: before !== undefined && view.info.name !== before.name,
  };
  // The run state travels with the transcript (the server read both in one
  // handler): a view that (re)connected while a run was going must render
  // it as running, and one whose run ended unwatched must stop showing it
  // as running (see applyRunState).
  const withRun = snapshot === undefined || movedByEvent.runState
    ? view
    : applyRunState(view, snapshot.running);
  const questions = snapshot === undefined || movedByEvent.questions
    ? view.pendingQuestions
    : snapshot.questions;
  const error = snapshot === undefined || movedByEvent.error
    ? view.error
    : snapshot.error;
  const name = snapshot === undefined || movedByEvent.name
    ? view.info.name
    : snapshot.name;
  const questionsChanged = snapshot !== undefined &&
    !movedByEvent.questions &&
    !sameQuestions(questions, view.pendingQuestions);
  const errorChanged = snapshot !== undefined && !movedByEvent.error &&
    error !== view.error;
  const nameChanged = snapshot !== undefined && !movedByEvent.name &&
    name !== view.info.name;
  const messages = snapshot === undefined ? view.messages : filterRemoved(
    mergeMessages(view.messages, snapshot.messages),
    view.removed,
  );
  const todo = parts.todos;
  const todoChanged = todo !== undefined && !sameTodoPlan(todo, view.todos);
  const fetchedTasks = parts.tasks;
  const tasks = fetchedTasks === undefined
    ? view.tasks
    : mergeTasks(view.tasks, fetchedTasks);
  const tasksChanged = fetchedTasks !== undefined &&
    !sameTasks(tasks, view.tasks);
  const fetchedBackgrounds = parts.backgrounds;
  const backgrounds = fetchedBackgrounds === undefined
    ? view.backgrounds
    : mergeBackgrounds(view.backgrounds, fetchedBackgrounds);
  const backgroundsChanged = fetchedBackgrounds !== undefined &&
    !sameBackgrounds(backgrounds, view.backgrounds);
  const fetchedGoal = parts.goal;
  const goalChanged = fetchedGoal !== undefined &&
    !sameGoal(fetchedGoal ?? undefined, view.goal);
  if (
    messages.length === view.messages.length && !todoChanged &&
    !tasksChanged && !backgroundsChanged && !goalChanged &&
    withRun === view && !questionsChanged && !errorChanged && !nameChanged
  ) {
    return view;
  }
  return {
    ...withRun,
    messages,
    ...(questionsChanged ? { pendingQuestions: questions } : {}),
    ...(errorChanged ? { error } : {}),
    ...(nameChanged ? { info: { ...withRun.info, name } } : {}),
    ...(todoChanged ? { todos: todo } : {}),
    ...(tasksChanged ? { tasks } : {}),
    ...(backgroundsChanged ? { backgrounds } : {}),
    ...(goalChanged ? { goal: fetchedGoal ?? undefined } : {}),
  };
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

/** True when two goal snapshots are identical (text, progress, status,
 * and reason). The resync replaces the snapshot, so an unchanged goal
 * must not trigger a view update on every sync tick. */
export function sameGoal(
  a: GoalInfo | undefined,
  b: GoalInfo | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.text === b.text && a.iteration === b.iteration &&
    a.maxIterations === b.maxIterations && a.status === b.status &&
    (a.lastReason ?? "") === (b.lastReason ?? "");
}

/** True when two background-command lists are identical (ids, commands, and
 * states). The resync replaces the whole list, so an unchanged snapshot
 * must not trigger a view update on every sync tick. The live output text
 * is derived state (deltas) and deliberately not compared. */
export function sameBackgrounds(
  a: BackgroundView[],
  b: BackgroundView[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((cmd, i) => {
    const other = b[i]!;
    return cmd.commandId === other.commandId &&
      cmd.command === other.command &&
      cmd.state === other.state;
  });
}

/** Merge the server's background snapshot into the view's list: known
 * commands take the snapshot's state/tail (the tail when longer — the
 * snapshot is a point-in-time tail, so the live view may be ahead of it);
 * unknown commands are appended oldest first (the snapshot is newest
 * first). */
export function mergeBackgrounds(
  existing: BackgroundView[],
  fetched: BackgroundCommandInfo[],
): BackgroundView[] {
  const byId = new Map(fetched.map((info) => [info.commandId, info]));
  const merged = existing.map((cmd) => {
    const info = byId.get(cmd.commandId);
    if (info === undefined) return cmd;
    return {
      ...cmd,
      state: info.state,
      finishedAt: info.finishedAt,
      exitCode: info.exitCode,
      tail: info.tail.length > cmd.tail.length ? info.tail : cmd.tail,
      liveText: info.tail.length > cmd.liveText.length
        ? info.tail
        : cmd.liveText,
    };
  });
  const known = new Set(existing.map((cmd) => cmd.commandId));
  for (const info of [...fetched].reverse()) {
    if (known.has(info.commandId)) continue;
    merged.push({ ...info, liveText: info.tail });
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
    case "messages_checkpoint": {
      // Older history was condensed into a checkpoint (the run keeps
      // streaming, so no run state is touched). Nothing was deleted: the
      // checkpoint is inserted at `event.index`, which is the position of
      // the first message the model still sees verbatim. A view that is
      // missing part of the preceding history (a resync in flight) appends
      // instead — the checkpoint row must never be dropped, it is what
      // marks where the model's view starts.
      const existing = view.messages.findIndex((m) =>
        messageKey(m) === messageKey(event.message)
      );
      if (existing !== -1) return null;
      const anchor = view.messages[event.index];
      const at = anchor === undefined
        ? -1
        : view.messages.findIndex((m) => messageKey(m) === messageKey(anchor));
      const messages = [...view.messages];
      messages.splice(at === -1 ? messages.length : at, 0, event.message);
      return { ...view, messages };
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
