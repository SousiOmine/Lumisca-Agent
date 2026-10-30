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
 *   request would spend the user's tokens on it every few minutes.
 *
 * The scheduler never runs a routine that is disabled, unreadable, or gone:
 * every step re-reads the row, because the user can delete or disable it
 * while a run is queued.
 */
import type { Routine } from "../shared/routine.ts";
import { nextRunAt } from "../shared/routine.ts";
import type { RoutineRepo } from "./repo.ts";
import { CoreError } from "../errors.ts";

/** How often the scheduler looks for due routines. A minute's granularity
 * would be enough for the schedules it supports, but the tick also drives
 * the catch-up check, and a shorter interval keeps a run within seconds of
 * its time. */
const DEFAULT_TICK_MS = 30_000;

/** How long after startup the first tick runs. A machine that just booted is
 * busy (the database opens, the model catalogue loads, the machine starts):
 * firing a routine into that crowd helps nobody. */
const CATCH_UP_DELAY_MS = 60_000;

/** How often a run waiting for a busy conversation asks again. */
const SLOT_POLL_MS = 2_000;

/** The seam the scheduler needs from the session layer: start a run in an
 * agent's conversation and know whether one is already running. Kept narrow
 * so the scheduler can be tested without a core. */
export interface RoutineRunner {
  /** Whether the agent's conversation is running (or about to). */
  isRunning(agentId: string): boolean;
  /** Start a run with `prompt` in the agent's conversation. Resolves when
   * the run finished; rejects when it could not start (no conversation). */
  run(
    agentId: string,
    prompt: string,
    routine: { id: string; name: string },
  ): Promise<RoutineRunOutcome>;
  /** Stop the run this routine started. A run the user started in the same
   * conversation is left alone. */
  stop(agentId: string, routineId: string): void;
}

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
  log?: (message: string) => void;
}

export interface RoutineScheduler {
  start(): void;
  /** Stop the timers. A run already going is not interrupted: it is the
   * agent's own run and stopping it would cut a half-finished answer. */
  close(): void;
  /** Run a routine now, without moving its schedule. Waits for a busy
   * conversation like a scheduled run does. */
  runNow(id: string): Promise<void>;
  /** Whether a run of this routine is in flight (including one waiting for
   * the conversation to be free). */
  isRunning(id: string): boolean;
  /** Stop a running routine's run. Only stops the run this routine started;
   * a user's own run is never touched. */
  stop(id: string): void;
}

export function createRoutineScheduler(
  options: RoutineSchedulerOptions,
): RoutineScheduler {
  const { repo, runner } = options;
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const catchUpDelayMs = options.catchUpDelayMs ?? CATCH_UP_DELAY_MS;
  const log = options.log ?? (() => {});

  /** Routine id → how many runs of it are in flight (a manual run plus a
   * scheduled one is two). */
  const running = new Map<string, number>();
  /** Routines whose in-flight run the user asked to stop. */
  const stopped = new Set<string>();
  /** Routines whose QUEUED run the user asked to stop (it never started). */
  const cancelled = new Set<string>();

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** One pass: start every due routine. Runs do not block the tick. */
  function tick(): void {
    const at = now();
    const due = repo.due(at);
    for (const routine of due) {
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
      void run(current);
    }
  }

  /** Start one run of `routine`, waiting for a free conversation. */
  async function run(routine: Routine): Promise<void> {
    const id = routine.id;
    running.set(id, (running.get(id) ?? 0) + 1);
    let started = false;
    try {
      // Wait for the conversation to be free. Never skip: a routine the
      // user scheduled must not silently do nothing because they were
      // typing (see the module comment).
      while (runner.isRunning(routine.agentId)) {
        if (cancelled.delete(id)) {
          record(id, {
            status: "stopped",
            detail: "Stopped before it started",
          });
          return;
        }
        if (repo.get(id) === undefined) return;
        await sleep(SLOT_POLL_MS);
      }
      if (cancelled.delete(id)) {
        record(id, { status: "stopped", detail: "Stopped before it started" });
        return;
      }
      if (repo.get(id) === undefined) return;
      started = true;
      const outcome = await runner.run(routine.agentId, routine.prompt, {
        id,
        name: routine.name,
      });
      const wasStopped = stopped.delete(id);
      record(id, {
        status: wasStopped
          ? "stopped"
          : outcome.failure === null
          ? "ok"
          : "error",
        detail: wasStopped ? "Stopped by the user" : outcome.failure,
      });
    } catch (error) {
      const wasStopped = stopped.delete(id);
      const message = error instanceof Error ? error.message : String(error);
      record(id, {
        status: wasStopped ? "stopped" : "error",
        detail: wasStopped ? "Stopped by the user" : message,
      });
    } finally {
      if (!started) stopped.delete(id);
      const left = (running.get(id) ?? 1) - 1;
      if (left <= 0) running.delete(id);
      else running.set(id, left);
    }
  }

  /** Write the run's result, keeping the next run as the tick left it (a
   * manual run did not move the schedule). */
  function record(
    id: string,
    outcome: { status: "ok" | "error" | "stopped"; detail: string | null },
  ): void {
    const current = repo.get(id);
    if (current === undefined) return;
    try {
      repo.recordRun(id, {
        lastRunAt: now(),
        lastStatus: outcome.status,
        lastDetail: outcome.detail,
        nextRunAt: current.enabled ? current.nextRunAt : null,
      });
    } catch (error) {
      log(
        `routine ${id}: could not record the result (${
          error instanceof Error ? error.message : String(error)
        })`,
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
      // what it would do, not a rescheduling.
      await run(routine);
    },

    isRunning(id: string): boolean {
      return (running.get(id) ?? 0) > 0;
    },

    stop(id: string): void {
      const routine = repo.get(id);
      if (routine === undefined || !running.has(id)) return;
      stopped.add(id);
      cancelled.add(id);
      // Only the run this routine started is stopped: the runner checks the
      // origin before interrupting anything (see RoutineRunner.stop).
      runner.stop(routine.agentId, id);
    },
  };
}
