import type { SessionSnapshot } from "@lumisca/core/shared";
import { withLatestContextUsage } from "@lumisca/core/shared";
import type {
  BackgroundCommandInfo,
  BackgroundView,
  PendingQuestion,
  SessionView,
  TaskInfo,
  TaskView,
  TodoPhase,
} from "../types.ts";
import {
  sameBackgrounds,
  sameQuestions,
  sameTasks,
  sameTodoPlan,
} from "./equality.ts";
import { applyRunState, mergeNewestWindow } from "./identity.ts";

/** The fetched snapshots of one session, as the resync collects them. Any
 * piece may be missing (its request failed); the rest are still applied. */
export interface SnapshotParts {
  snapshot?: SessionSnapshot;
  todos?: TodoPhase[];
  tasks?: TaskInfo[];
  backgrounds?: BackgroundCommandInfo[];
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
 *   commands merge per id so live deltas are preserved.
 * Messages merge append-only, minus the rewind tombstones: a message
 * deleted while the socket was down must not come back. */
export function applySnapshot(
  view: SessionView,
  parts: SnapshotParts,
  before: LiveStateBefore | undefined,
): SessionView {
  const { snapshot } = parts;
  const movedByEvent = {
    runState:
      before !== undefined &&
      (view.agentStartedAt !== before.started ||
        view.agentEndedAt !== before.ended),
    questions:
      before !== undefined && view.pendingQuestions !== before.questions,
    error: before !== undefined && view.error !== before.error,
    name: before !== undefined && view.info.name !== before.name,
  };
  // The run state travels with the transcript (the server read both in one
  // handler): a view that (re)connected while a run was going must render
  // it as running, and one whose run ended unwatched must stop showing it
  // as running (see applyRunState).
  const withRun =
    snapshot === undefined || movedByEvent.runState
      ? view
      : applyRunState(view, snapshot.running);
  const questions =
    snapshot === undefined || movedByEvent.questions
      ? view.pendingQuestions
      : snapshot.questions;
  const error =
    snapshot === undefined || movedByEvent.error ? view.error : snapshot.error;
  const name =
    snapshot === undefined || movedByEvent.name
      ? view.info.name
      : snapshot.name;
  const questionsChanged =
    snapshot !== undefined &&
    !movedByEvent.questions &&
    !sameQuestions(questions, view.pendingQuestions);
  const errorChanged =
    snapshot !== undefined && !movedByEvent.error && error !== view.error;
  const nameChanged =
    snapshot !== undefined && !movedByEvent.name && name !== view.info.name;
  // The snapshot is a WINDOW of the transcript (see mergeNewestWindow): it
  // extends the view forwards, and the view's cursor stays true because
  // paging back is the reader's action, not a resync's.
  const history =
    snapshot === undefined
      ? { messages: view.messages, older: view.older }
      : mergeNewestWindow(
          view,
          { messages: snapshot.messages, older: snapshot.older },
          view.removed,
        );
  const messages = history.messages;
  const older = history.older;
  const usage =
    snapshot === undefined
      ? view.usage
      : withLatestContextUsage(snapshot.usage, messages);
  // A snapshot counts whole history: the meter must not blink when the
  // summary moved (a run priced another turn) while the messages did not.
  const usageChanged = usage !== view.usage;
  const todo = parts.todos;
  const todoChanged = todo !== undefined && !sameTodoPlan(todo, view.todos);
  const fetchedTasks = parts.tasks;
  const tasks =
    fetchedTasks === undefined
      ? view.tasks
      : mergeTasks(view.tasks, fetchedTasks);
  const tasksChanged =
    fetchedTasks !== undefined && !sameTasks(tasks, view.tasks);
  const fetchedBackgrounds = parts.backgrounds;
  const backgrounds =
    fetchedBackgrounds === undefined
      ? view.backgrounds
      : mergeBackgrounds(view.backgrounds, fetchedBackgrounds);
  const backgroundsChanged =
    fetchedBackgrounds !== undefined &&
    !sameBackgrounds(backgrounds, view.backgrounds);
  if (
    messages === view.messages &&
    older === view.older &&
    !usageChanged &&
    !todoChanged &&
    !tasksChanged &&
    !backgroundsChanged &&
    withRun === view &&
    !questionsChanged &&
    !errorChanged &&
    !nameChanged
  ) {
    return view;
  }
  return {
    ...withRun,
    messages,
    older,
    usage,
    ...(questionsChanged ? { pendingQuestions: questions } : {}),
    ...(errorChanged ? { error } : {}),
    ...(nameChanged ? { info: { ...withRun.info, name } } : {}),
    ...(todoChanged ? { todos: todo } : {}),
    ...(tasksChanged ? { tasks } : {}),
    ...(backgroundsChanged ? { backgrounds } : {}),
  };
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
      liveText:
        info.tail.length > cmd.liveText.length ? info.tail : cmd.liveText,
    };
  });
  const known = new Set(existing.map((cmd) => cmd.commandId));
  for (const info of [...fetched].reverse()) {
    if (known.has(info.commandId)) continue;
    merged.push({ ...info, liveText: info.tail });
  }
  return merged;
}
