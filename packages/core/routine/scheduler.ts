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
 *
 * The scheduler never runs a routine that is disabled, unreadable, or gone:
 * every step re-reads the row, because the user can delete or disable it
 * while a run is queued.
 */
import type { Routine } from "../shared/routine.ts";
import { nextRunAt } from "../shared/routine.ts";
import type { RoutineRepo, RoutineWatchResult } from "./repo.ts";
import { CoreError, errorMessage } from "../errors.ts";
import { sleep } from "../shared/misc.ts";

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

/** How long a check that cannot run at all waits before looking again. A
 * machine that is down answers the same thing every time, and every check
 * costs a process inside the container: repeating it at the routine's own
 * interval is work with a known answer. Fifteen minutes is longer than any
 * watch interval the user can pick (the floor is five). */
const WATCH_RETRY_MS = 15 * 60_000;

/** How long a run waits for its conversation to be free before giving up.
 * "Waited for, not skipped" must not turn into "piled up for ever": a
 * conversation blocked on a hand-over does not free itself until the user
 * comes back, while the routine's own interval keeps producing occurrences.
 * An hour is long enough that a normal run ends first, and short enough that
 * the result still describes what the user asked about. */
const DEFAULT_QUEUE_MAX_WAIT_MS = 60 * 60_000;

/** What a waiting run records when it is dropped. Stored as the routine's
 * detail, so the settings list says what happened instead of nothing. */
const QUEUE_GAVE_UP_DETAIL =
  "The conversation stayed busy for an hour, so this run was skipped";

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
  | { kind: "changed"; state: unknown }
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

/** Where a routine's run is right now. `queued` is a run that is waiting for
 * the conversation and has produced nothing yet; the settings list draws it
 * differently from `running`, because a run that waits and never starts is
 * not something the user can see working. */
export type RoutineRunState = "idle" | "queued" | "running";

export interface RoutineScheduler {
  start(): void;
  /** Stop the timers. A run already going is not interrupted: it is the
   * agent's own run and stopping it would cut a half-finished answer. */
  close(): void;
  /** Run a routine now, without moving its schedule. Waits for a busy
   * conversation like a scheduled run does. */
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

export function createRoutineScheduler(
  options: RoutineSchedulerOptions,
): RoutineScheduler {
  const { repo, runner } = options;
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const catchUpDelayMs = options.catchUpDelayMs ?? CATCH_UP_DELAY_MS;
  const queueMaxWaitMs = options.queueMaxWaitMs ?? DEFAULT_QUEUE_MAX_WAIT_MS;
  const slotPollMs = options.slotPollMs ?? SLOT_POLL_MS;
  const log = options.log ?? (() => {});

  /** Routine id → how many of its runs are actually running (the wait is
   * over and the agent was asked). */
  const running = new Map<string, number>();
  /** Routine id → when its ONE waiting run started waiting. The bound lives
   * here rather than in the database: a queued run is this process's memory,
   * like `running`. */
  const queued = new Map<string, number>();
  /** Routines whose in-flight run the user asked to stop. */
  const stopped = new Set<string>();
  /** Routines whose QUEUED run the user asked to stop (it never started). */
  const cancelled = new Set<string>();

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;

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
      // A watch schedule is a CHECK cadence, not a run cadence: the run
      // happens only when the check says something changed. Advancing
      // next_run_at above is still right — it is when to look again.
      if (current.schedule.kind === "watch") {
        void checkOnce(current);
        continue;
      }
      void run(current);
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
    void run(current);
  }

  /** Write one check's record. A failure here belongs to the row, not to the
   * run: nothing about the routine's run was decided by it. */
  function recordCheck(routine: Routine, result: RoutineWatchResult): void {
    try {
      repo.recordWatch(routine.id, result);
    } catch (error) {
      log(
        `routine ${routine.id}: could not record the check (${
          errorMessage(error)
        })`,
      );
    }
  }

  /** Start one run of `routine`, waiting for a free conversation.
   *
   * At most ONE run of a routine waits at a time: occurrences that come due
   * while one is already waiting are dropped (their next run is already
   * scheduled), because six occurrences of a five-minute routine released at
   * once would start six runs of the same request. A wait that lasts longer
   * than `queueMaxWaitMs` gives up instead of holding the slot for ever. */
  async function run(routine: Routine): Promise<void> {
    const id = routine.id;
    // Already waiting: this occurrence is one too many, and the next is
    // scheduled anyway.
    if (queued.has(id)) return;
    queued.set(id, now());
    let started = false;
    try {
      // Wait for the conversation to be free. Never skip silently: a routine
      // the user scheduled must not do nothing because they were typing (see
      // the module comment) — it waits, and says so.
      while (runner.isRunning(routine.agentId)) {
        if (cancelled.delete(id)) {
          recordNote(id, "stopped", "Stopped before it started");
          return;
        }
        if (repo.get(id) === undefined) return;
        if (now() - (queued.get(id) ?? now()) >= queueMaxWaitMs) {
          recordNote(id, "skipped", QUEUE_GAVE_UP_DETAIL);
          return;
        }
        await sleep(slotPollMs);
      }
      if (cancelled.delete(id)) {
        recordNote(id, "stopped", "Stopped before it started");
        return;
      }
      if (repo.get(id) === undefined) return;
      started = true;
      queued.delete(id);
      running.set(id, (running.get(id) ?? 0) + 1);
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
      const message = errorMessage(error);
      record(id, {
        status: wasStopped ? "stopped" : "error",
        detail: wasStopped ? "Stopped by the user" : message,
      });
    } finally {
      if (!started) stopped.delete(id);
      queued.delete(id);
      const left = (running.get(id) ?? 0) - 1;
      if (left <= 0) running.delete(id);
      else running.set(id, left);
    }
  }

  /** Record an outcome that is NOT a run: the prompt never reached the
   * agent (it was stopped while waiting, or the wait gave up). `last_run_at`
   * must not move for it — the settings list would then name a time at which
   * nothing ran. */
  function recordNote(
    id: string,
    status: "stopped" | "skipped",
    detail: string,
  ): void {
    if (repo.get(id) === undefined) return;
    try {
      repo.recordNote(id, { status, detail });
    } catch (error) {
      log(
        `routine ${id}: could not record the outcome (${errorMessage(error)})`,
      );
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
        `routine ${id}: could not record the result (${errorMessage(error)})`,
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
      return (running.get(id) ?? 0) > 0 || queued.has(id);
    },

    isQueued(id: string): boolean {
      return queued.has(id);
    },

    stateOf(id: string): RoutineRunState {
      if ((running.get(id) ?? 0) > 0) return "running";
      return queued.has(id) ? "queued" : "idle";
    },

    stop(id: string): void {
      const routine = repo.get(id);
      if (routine === undefined) return;
      const waiting = queued.has(id);
      const active = running.has(id);
      if (!waiting && !active) return;
      // Waiting and running are two different facts. A waiting run is
      // cancelled before it starts; a running one is interrupted and records
      // itself as stopped when it ends. Marking a RUNNING routine as
      // cancelled would leave the mark behind and swallow its next run.
      if (waiting) cancelled.add(id);
      if (active) stopped.add(id);
      // Only the run this routine started is stopped: the runner checks the
      // origin before interrupting anything (see RoutineRunner.stop).
      runner.stop(routine.agentId, id);
    },
  };
}
