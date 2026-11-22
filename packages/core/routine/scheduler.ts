/**
 * The routine scheduler.
 *
 * A routine runs by starting an ordinary run in its agent's conversation
 * with the routine's prompt: the same delivery a typed message gets, so the
 * agent sees one continuous conversation and the user sees the result in the
 * transcript (marked with the routine's name).
 *
 * Three decisions shape this module:
 *
 * - **The next run is advanced before the run starts.** A routine whose run
 *   takes an hour would otherwise be due on every tick for that hour and
 *   fire in parallel with itself. Advancing first makes "one run per slot" a
 *   fact rather than a hope.
 * - **A busy conversation is waited for, not skipped.** A routine that
 *   quietly does nothing because the user was typing is worse than one that
 *   runs a minute late: the user scheduled it and expects the result.
 * - **Nothing is retried.** A failed run records its reason for the settings
 *   list and waits for the next scheduled time. Silently retrying a failing
 *   request would spend the user's tokens on it every few minutes. A check
 *   that could not run at all is not a run: it waits longer than its own
 *   interval (see WATCH_RETRY_MS) and records that in its own columns, so a
 *   machine that is down never looks like a routine that keeps failing.
 * - **A one-off is consumed by its run.** A `once` routine has no next
 *   occurrence, so the run that starts is also the routine's last: the row
 *   is removed when the run ends. Keeping it would leave a row that either
 *   fires again (if its slot survived) or claims a next run it can never
 *   have.
 *
 * The scheduler never runs a routine that is disabled, unreadable, or gone:
 * every step re-reads the row, because the user can delete or disable it
 * while a run is queued. The one exception is the one-off described above:
 * its slot is emptied (and the row switched off) BEFORE its run starts, so
 * "switched off" is what a one-off looks like while it runs.
 *
 * It also never runs anything for an agent the user has switched off. That
 * is the agent's state, not the routine's: a due occurrence is spent without
 * a run, a queued one is recorded as skipped, and a watch's check is not made
 * (it would cost a process inside the machine for a conversation that cannot
 * open). The user's own on/off switches on the rows are left as they are.
 */

import { CoreError, errorMessage } from "../errors.ts";
import type { Routine } from "../shared/routine.ts";
import { nextRunAt } from "../shared/routine.ts";
import { RoutineExecutor, type RoutineTrigger } from "./executor.ts";
import { RoutineQueue, type RoutineRunState } from "./queue.ts";
import type { RoutineRepo, RoutineWatchResult } from "./repo.ts";

export type { RoutineTrigger } from "./executor.ts";
export type { RoutineRunState } from "./queue.ts";

/** How often the scheduler looks for due routines. A minute's granularity
 * would be enough for the schedules it supports, but the tick also drives
 * the catch-up check, and a shorter interval keeps a run within seconds of
 * its time. */
const DEFAULT_TICK_MS = 30_000;

/** How long after startup the first tick runs. A machine that just booted is
 * busy (the database opens, the model catalogue loads, the machine starts):
 * firing a routine into that crowd helps nobody. */
const CATCH_UP_DELAY_MS = 60_000;

/** How long a check that cannot run at all waits before looking again. A
 * machine that is down answers the same thing every time, and every check
 * costs a process inside the container: repeating it at the routine's own
 * interval is work with a known answer. Fifteen minutes is longer than any
 * watch interval the user can pick (the floor is five). */
const WATCH_RETRY_MS = 15 * 60_000;

/** The seam the scheduler needs from the session layer: start a run in an
 * agent's conversation and know whether one is already running. Kept narrow
 * so the scheduler can be tested without a core. */
export interface RoutineRunner {
  /** Whether the agent's conversation is running (or about to). */
  isRunning(agentId: string): boolean;
  /** Whether the agent is switched on. A disabled agent has no conversation
   * to run in — it is read-only — so its routines wait instead of building
   * one behind the user's back. A routine's own on/off switch is a different
   * fact: this one names the agent the routine belongs to. */
  isAgentEnabled(agentId: string): boolean;
  /** Start a run with `prompt` in the agent's conversation. Resolves when
   * the run finished; rejects when it could not start (no conversation).
   * `trigger` is set when a check started this run, so the run knows what
   * fired it without reading the source again. */
  run(
    agentId: string,
    prompt: string,
    routine: { id: string; name: string },
    trigger?: RoutineTrigger,
  ): Promise<RoutineRunOutcome>;
  /** Stop the run this routine started. A run the user started in the same
   * conversation is left alone. */
  stop(agentId: string, routineId: string): void;
  /** Run a `watch` routine's check and say whether anything changed. No
   * inference call happens here — that is the point (see vm/watch.ts). A
   * routine that is not a watch, or one whose machine cannot run the check,
   * answers `unsupported`.
   *
   * The whole routine is passed, not its agent and source: the previous
   * observation is a field of THIS routine, and looking it up again by
   * (agent, source) matches nothing (a stored value is a new object on every
   * read) or another routine watching the same source. */
  check(routine: Routine): Promise<WatchCheck>;
}

/** What one check answered. `state` is what to store for the next check;
 * undefined leaves the stored state alone (nothing was observed). */
export type WatchCheck =
  | { kind: "changed"; state: unknown; newItems?: number }
  | { kind: "same"; state: unknown }
  | { kind: "unsupported"; problem: string }
  | { kind: "error"; state?: unknown; problem: string };

/** How a started run ended. */
export interface RoutineRunOutcome {
  /** Why it failed, or null when it completed. */
  failure: string | null;
}

export interface RoutineSchedulerOptions {
  repo: RoutineRepo;
  runner: RoutineRunner;
  /** Whether a run of this routine is still in flight (reported by the
   * settings list; kept in this scheduler, not in the database). */
  now?: () => number;
  tickMs?: number;
  /** Delay before the first tick (tests shorten it along with tickMs). */
  catchUpDelayMs?: number;
  /** How long a run waits for a free conversation (tests shorten it). */
  queueMaxWaitMs?: number;
  /** How often a waiting run asks again (tests shorten it). */
  slotPollMs?: number;
  log?: (message: string) => void;
}

export interface RoutineScheduler {
  start(): void;
  /** Stop the timers. A run already going is not interrupted: it is the
   * agent's own run and stopping it would cut a half-finished answer. */
  close(): void;
  /** Run a routine now, without moving its schedule. Waits for a busy
   * conversation like a scheduled run does. A one-off is used up by it: the
   * row is removed when the run ends, since there would be nothing left for
   * its time to do. */
  runNow(id: string): Promise<void>;
  /** Whether a run of this routine is in flight, INCLUDING one still waiting
   * for the conversation (see stateOf for the distinction). */
  isRunning(id: string): boolean;
  /** Whether this routine's run is waiting for a free conversation. */
  isQueued(id: string): boolean;
  /** Where this routine's run is: idle, waiting, or running. */
  stateOf(id: string): RoutineRunState;
  /** Stop a running routine's run. Only stops the run this routine started;
   * a user's own run is never touched. */
  stop(id: string): void;
}

/** The report a fire-and-forget task gives when it fails: a routine that
 * could not run is a row that says so, never an exception nobody saw. */
export type RoutineReport = (message: string) => void;

export function createRoutineScheduler(
  options: RoutineSchedulerOptions,
): RoutineScheduler {
  const { repo, runner } = options;
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const catchUpDelayMs = options.catchUpDelayMs ?? CATCH_UP_DELAY_MS;
  const log = options.log ?? (() => {});
  const queue = new RoutineQueue(now);
  const executor = new RoutineExecutor({
    repo,
    runner,
    queue,
    now,
    log,
    ...(options.queueMaxWaitMs === undefined
      ? {}
      : { queueMaxWaitMs: options.queueMaxWaitMs }),
    ...(options.slotPollMs === undefined
      ? {}
      : { slotPollMs: options.slotPollMs }),
  });

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  /** A timer callback already queued when close() ran must not read the
   * database the core is about to close. */
  let closed = false;

  /** Run one task without waiting for it, and report what it threw. Every
   * run of a routine goes through this: the tick must not be blocked by a
   * run, and a failure must reach the log rather than a dropped promise. */
  function fire(task: Promise<void>, what: string): void {
    void task.catch((error) => {
      log(`routine ${what}: ${errorMessage(error)}`);
    });
  }

  /** One pass: start every due routine. Runs do not block the tick. */
  function tick(): void {
    if (closed) return;
    const at = now();
    const due = repo.due(at);
    for (const routine of due) {
      // A disabled agent's routines do not fire, and this is where they are
      // stopped before anything is read from the machine: a check would cost
      // a process inside the container for a conversation that cannot open.
      // The occurrence is spent rather than kept, so enabling the agent does
      // not release a pile of past runs. A one-off has no next slot: its row
      // stays, and it fires once the agent is back on.
      if (!runner.isAgentEnabled(routine.agentId)) {
        if (routine.schedule.kind === "once") continue;
        try {
          repo.update(routine.id, {
            nextRunAt: nextRunAt(routine.schedule, at),
          });
        } catch {
          // The row vanished between the query and here; nothing to skip.
        }
        continue;
      }
      // A one-off has no next slot to advance to, so emptying it IS the
      // advance: without it the row stays due for as long as the run lasts
      // and fires again on the next tick. Switching it off in the same write
      // is what makes a process that dies mid-run leave a row that cannot
      // fire, rather than one that repeats.
      if (routine.schedule.kind === "once") {
        try {
          repo.update(routine.id, { nextRunAt: null, enabled: false });
        } catch {
          // The row vanished between the query and here; nothing to run.
          continue;
        }
        const oneOff = repo.get(routine.id);
        if (oneOff === undefined) continue;
        fire(executor.run(oneOff), oneOff.id);
        continue;
      }
      // Advance first (see the module comment): the stored row must already
      // point past this run before anything can ask again.
      try {
        repo.update(routine.id, { nextRunAt: nextRunAt(routine.schedule, at) });
      } catch {
        // The row vanished between the query and here; nothing to run.
        continue;
      }
      const current = repo.get(routine.id);
      if (current === undefined) continue;
      // A watch schedule is a CHECK cadence, not a run cadence: the run
      // happens only when the check says something changed. Advancing
      // next_run_at above is still right — it is when to look again.
      if (current.schedule.kind === "watch") {
        fire(checkOnce(current), current.id);
        continue;
      }
      fire(executor.run(current), current.id);
    }
  }

  /** One look at a watch routine: check, record what was seen, and start a
   * run only if the answer is "changed".
   *
   * The check is not a run, and is recorded as its own thing: its outcome
   * goes into the routine's check columns, so a machine that is down cannot
   * make the settings list say the routine failed, and the "last run" line
   * keeps describing the last run the user actually got. A check that could
   * not run at all (no machine, no conversation) backs off instead of asking
   * the same dead end every interval; the routine stays enabled, because
   * stopping a routine the user scheduled is the user's decision. */
  async function checkOnce(routine: Routine): Promise<void> {
    if (routine.schedule.kind !== "watch") return;
    let outcome: WatchCheck;
    try {
      outcome = await runner.check(routine);
    } catch (error) {
      outcome = { kind: "error", problem: errorMessage(error) };
    }
    const at = now();
    if (outcome.kind === "unsupported") {
      recordCheck(routine, {
        state: undefined,
        nextRunAt: at + WATCH_RETRY_MS,
        checkedAt: at,
        error: outcome.problem,
      });
      return;
    }
    // A check that could not observe keeps the previous baseline (it never
    // saw a new value), so the next successful one still compares.
    recordCheck(routine, {
      state: outcome.kind === "error" ? undefined : outcome.state,
      nextRunAt: nextRunAt(routine.schedule, at),
      checkedAt: at,
      error: outcome.kind === "error" ? outcome.problem : null,
    });
    if (outcome.kind !== "changed") return;
    // Changed: run it. The row's next check was already advanced by the tick.
    const current = repo.get(routine.id);
    if (current === undefined) return;
    // The number belongs to THIS check's answer, not to the row: the row's
    // state is already the new baseline, so the count is only knowable here.
    await executor.run(
      current,
      outcome.newItems === undefined
        ? undefined
        : { at, newItems: outcome.newItems },
    );
  }

  /** Write one check's record. A failure here belongs to the row, not to the
   * run: nothing about the routine's run was decided by it. */
  function recordCheck(routine: Routine, result: RoutineWatchResult): void {
    try {
      repo.recordWatch(routine.id, result);
    } catch (error) {
      log(
        `routine ${routine.id}: could not record the check (${errorMessage(
          error,
        )})`,
      );
    }
  }

  return {
    start(): void {
      if (tickTimer !== null || firstTimer !== null) return;
      // The first wait is the startup delay, independent of the tick: a
      // process that just booted has other things to do (see
      // CATCH_UP_DELAY_MS), and tests shorten it too.
      const delay = catchUpDelayMs;
      firstTimer = setTimeout(() => {
        firstTimer = null;
        tick();
        tickTimer = setInterval(tick, tickMs);
      }, delay);
    },

    close(): void {
      closed = true;
      if (firstTimer !== null) {
        clearTimeout(firstTimer);
        firstTimer = null;
      }
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    },

    async runNow(id: string): Promise<void> {
      const routine = repo.get(id);
      if (routine === undefined) {
        throw new CoreError(`Routine not found: ${id}`, "not_found");
      }
      // The schedule is deliberately left alone: "run it now" is a look at
      // what it would do, not a rescheduling. A one-off is still used up by
      // the run (see RoutineExecutor.run).
      await executor.run(routine);
    },

    isRunning(id: string): boolean {
      return queue.isBusy(id);
    },

    isQueued(id: string): boolean {
      return queue.isQueued(id);
    },

    stateOf(id: string): RoutineRunState {
      return queue.stateOf(id);
    },

    stop(id: string): void {
      const routine = repo.get(id);
      if (routine === undefined) return;
      // Waiting and running are two different facts. A waiting run is
      // cancelled before it starts; a running one is interrupted and records
      // itself as stopped when it ends. Marking a RUNNING routine as
      // cancelled would leave the mark behind and swallow its next run.
      const waiting = queue.cancelWaiting(id);
      const active = queue.markRunningStopped(id);
      if (!waiting && !active) return;
      // Only the run this routine started is stopped: the runner checks the
      // origin before interrupting anything (see RoutineRunner.stop).
      runner.stop(routine.agentId, id);
    },
  };
}
