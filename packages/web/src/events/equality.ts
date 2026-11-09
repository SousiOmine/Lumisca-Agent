import { sameAsks } from "@lumisca/core/shared";
import type {
  BackgroundView,
  GoalInfo,
  PendingQuestion,
  TaskView,
  TodoPhase,
} from "../types.ts";

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
 * same order, with the same questions. A pending ask's questions never
 * change while it waits (they are fixed when the tool asks), so the tool call
 * and the question ids are the whole identity — a resync that re-sends the
 * same list must not re-render a tab. */
export function sameQuestions(
  a: PendingQuestion[],
  b: PendingQuestion[],
): boolean {
  return sameAsks(a, b);
}

/** Whether an event's revision skips past what this view has seen: the
 * stream is ordered and reliable while it is up, so a count that jumps
 * means frames were lost (a socket that died without a close event, a
 * peer's relay gap) and the view must re-read its snapshot. `known`
 * undefined means nothing was seen yet for that session (its first event
 * only seeds the marker: nothing was expected before it), and a count that
 * does not advance (a duplicate delivery) is not a gap.
 *
 * `events` is how many events the frame accounts for: the server batches a
 * run's text deltas into one frame per display interval (see
 * core/shared/ws-batch.ts), so one frame advances the count by several. The
 * frame says how many, which is what keeps "one frame for six tokens" from
 * being read as "five frames went missing" — a false gap would re-read the
 * snapshot on every batch and make the remote path slower than before. */
export function revisionGap(
  known: number | undefined,
  rev: number,
  events = 1,
): boolean {
  return known !== undefined && rev > known + events;
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
