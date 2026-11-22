/**
 * One routine run: wait for a free conversation, ask the agent, record what
 * happened.
 *
 * The scheduler decides WHEN a routine runs (the tick, the schedule, the
 * check cadence); this decides what one run does, and it is the only place
 * that talks to the agent for a routine. Everything it learns from a run ends
 * up on the row — the outcome, the reason, and for a one-off the deletion —
 * so the settings list never has to guess.
 *
 * Nothing is retried: a failed run records its reason and waits for the next
 * scheduled time. Silently retrying a failing request would spend the user's
 * tokens on it every few minutes.
 *
 * A wait that fails, a stop, and a conversation that never frees itself all
 * leave the row saying what happened, because a routine that quietly did
 * nothing is worse than one that ran a minute late.
 */

import { errorMessage } from "../errors.ts";
import { sleep } from "../shared/misc.ts";
import type { Routine } from "../shared/routine.ts";
import type { RoutineQueue } from "./queue.ts";
import type { RoutineRepo } from "./repo.ts";
import type { RoutineRunner } from "./scheduler.ts";

/** How often a run waiting for a busy conversation asks again. */
const SLOT_POLL_MS = 2_000;

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

/** What a run records when its agent is switched off. */
const AGENT_DISABLED_DETAIL = "The agent is disabled";

/** What a waiting run records when the user stops it. */
const STOPPED_BEFORE_START_DETAIL = "Stopped before it started";

/** What a running routine records when the user stops it. */
const STOPPED_BY_USER_DETAIL = "Stopped by the user";

/** What a check saw when it fired (see WatchCheck.changed). The run is told
 * the count so it does not have to read the source again to find out how
 * much happened — and so a run that starts after the items were read
 * elsewhere (a user's own look at the mailbox) does not lose them. */
export interface RoutineTrigger {
  /** When the check fired (epoch ms). */
  at: number;
  /** How many items the observation had that the previous one did not. */
  newItems: number;
}

export interface RoutineExecutorOptions {
  repo: RoutineRepo;
  runner: RoutineRunner;
  queue: RoutineQueue;
  /** How long a run waits for a free conversation (tests shorten it). */
  queueMaxWaitMs?: number;
  /** How often a waiting run asks again (tests shorten it). */
  slotPollMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export class RoutineExecutor {
  readonly #repo: RoutineRepo;
  readonly #runner: RoutineRunner;
  readonly #queue: RoutineQueue;
  readonly #queueMaxWaitMs: number;
  readonly #slotPollMs: number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;

  constructor(options: RoutineExecutorOptions) {
    this.#repo = options.repo;
    this.#runner = options.runner;
    this.#queue = options.queue;
    this.#queueMaxWaitMs = options.queueMaxWaitMs ?? DEFAULT_QUEUE_MAX_WAIT_MS;
    this.#slotPollMs = options.slotPollMs ?? SLOT_POLL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? (() => {});
  }

  /** Start one run of `routine`, waiting for a free conversation.
   *
   * At most ONE run of a routine waits at a time (see RoutineQueue): a second
   * occurrence while one waits is dropped, because six occurrences of a
   * five-minute routine released at once would start six runs of the same
   * request. A wait longer than `queueMaxWaitMs` gives up instead of holding
   * the slot for ever.
   *
   * A `once` routine is removed once this run ends (see the module comment). */
  async run(routine: Routine, trigger?: RoutineTrigger): Promise<void> {
    const id = routine.id;
    // Read before the run: by the time this returns, the row may be gone.
    const oneOff = routine.schedule.kind === "once";
    // Already waiting: this occurrence is one too many, and the next is
    // scheduled anyway.
    if (!this.#queue.beginWait(id)) return;
    // The agent was switched off after this run was queued, or the user
    // pressed "run now" on a disabled agent. Saying so on the row is what
    // keeps a silent no-op from looking like a run that did nothing.
    if (!this.#runner.isAgentEnabled(routine.agentId)) {
      this.#recordNote(id, "skipped", AGENT_DISABLED_DETAIL);
      return;
    }
    let started = false;
    try {
      const waited = await this.#waitForSlot(routine);
      if (!waited.ok) {
        this.#recordNote(id, waited.status, waited.detail);
        return;
      }
      if (this.#repo.get(id) === undefined) return;
      started = true;
      this.#queue.beginRun(id);
      const outcome = await this.#runner.run(
        routine.agentId,
        routine.prompt,
        { id, name: routine.name },
        trigger,
      );
      const wasStopped = this.#queue.takeStopped(id);
      this.#record(id, {
        status: wasStopped
          ? "stopped"
          : outcome.failure === null
            ? "ok"
            : "error",
        detail: wasStopped ? STOPPED_BY_USER_DETAIL : outcome.failure,
      });
    } catch (error) {
      const wasStopped = this.#queue.takeStopped(id);
      const message = errorMessage(error);
      this.#record(id, {
        status: wasStopped ? "stopped" : "error",
        detail: wasStopped ? STOPPED_BY_USER_DETAIL : message,
      });
    } finally {
      if (!started) this.#queue.forgetStopped(id);
      this.#queue.endRun(id);
      // Only a run that STARTED consumes a one-off: a run that was stopped
      // while waiting, or that gave up, never happened, and the row stays
      // (with its reason) for the user to see or run.
      if (started && oneOff) this.#removeOneOff(id);
    }
  }

  /** Wait until the agent's conversation is free, or say why the run stops
   * waiting. Never returns "free" for a row the user deleted in the
   * meantime. */
  async #waitForSlot(
    routine: Routine,
  ): Promise<
    { ok: true } | { ok: false; status: "stopped" | "skipped"; detail: string }
  > {
    const id = routine.id;
    // Never skip silently: a routine the user scheduled must not do nothing
    // because they were typing (see the module comment) — it waits, and says
    // so.
    while (this.#runner.isRunning(routine.agentId)) {
      if (this.#queue.takeCancelled(id)) {
        return {
          ok: false,
          status: "stopped",
          detail: STOPPED_BEFORE_START_DETAIL,
        };
      }
      if (this.#repo.get(id) === undefined)
        return {
          ok: false,
          status: "stopped",
          detail: STOPPED_BEFORE_START_DETAIL,
        };
      const since = this.#queue.waitingSince(id) ?? this.#now();
      if (this.#now() - since >= this.#queueMaxWaitMs) {
        return { ok: false, status: "skipped", detail: QUEUE_GAVE_UP_DETAIL };
      }
      await sleep(this.#slotPollMs);
    }
    if (this.#queue.takeCancelled(id)) {
      return {
        ok: false,
        status: "stopped",
        detail: STOPPED_BEFORE_START_DETAIL,
      };
    }
    return { ok: true };
  }

  /** Drop a one-off whose run has ended. Called after the outcome was
   * recorded, so a deletion that fails leaves a row that says what happened
   * and has nothing left to fire. */
  #removeOneOff(id: string): void {
    try {
      this.#repo.delete(id);
    } catch (error) {
      this.#log(
        `routine ${id}: could not remove the one-off after its run (${errorMessage(
          error,
        )})`,
      );
    }
  }

  /** Record an outcome that is NOT a run: the prompt never reached the
   * agent (it was stopped while waiting, or the wait gave up). `last_run_at`
   * must not move for it — the settings list would then name a time at which
   * nothing ran. */
  #recordNote(id: string, status: "stopped" | "skipped", detail: string): void {
    if (this.#repo.get(id) === undefined) return;
    try {
      this.#repo.recordNote(id, { status, detail });
    } catch (error) {
      this.#log(
        `routine ${id}: could not record the outcome (${errorMessage(error)})`,
      );
    }
  }

  /** Write the run's result, keeping the next run as the tick left it (a
   * manual run did not move the schedule). */
  #record(
    id: string,
    outcome: { status: "ok" | "error" | "stopped"; detail: string | null },
  ): void {
    const current = this.#repo.get(id);
    if (current === undefined) return;
    try {
      this.#repo.recordRun(id, {
        lastRunAt: this.#now(),
        lastStatus: outcome.status,
        lastDetail: outcome.detail,
        nextRunAt: current.enabled ? current.nextRunAt : null,
      });
    } catch (error) {
      this.#log(
        `routine ${id}: could not record the result (${errorMessage(error)})`,
      );
    }
  }
}
