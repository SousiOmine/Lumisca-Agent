/**
 * Which routine runs are in flight, which are waiting, and which the user
 * asked to stop.
 *
 * None of this is in the database: a queued run is this process's memory, like
 * a running one, and a restart ends both. What the queue owns is only the
 * COUNTING — one run per routine at a time, at most one run waiting behind it,
 * and the two marks a stop leaves — so the executor can ask one question
 * ("may this run start now?") instead of keeping four maps of its own.
 *
 * The distinction the queue keeps is the one the settings list draws: a run
 * that has not started is `queued` and can be cancelled without touching the
 * conversation; a run that started is `running` and is only recorded as
 * stopped when it ends.
 */

/** Where a routine's run is right now. `queued` is a run that is waiting for
 * the conversation and has produced nothing yet; the settings list draws it
 * differently from `running`, because a run that waits and never starts is
 * not something the user can see working. */
export type RoutineRunState = "idle" | "queued" | "running";

export class RoutineQueue {
  /** Routine id → how many of its runs are actually running (the wait is
   * over and the agent was asked). */
  readonly #running = new Map<string, number>();
  /** Routine id → when its ONE waiting run started waiting. */
  readonly #queued = new Map<string, number>();
  /** Routines whose in-flight run the user asked to stop. */
  readonly #stopped = new Set<string>();
  /** Routines whose QUEUED run the user asked to stop (it never started). */
  readonly #cancelled = new Set<string>();

  constructor(private readonly now: () => number) {}

  /** Whether a run of this routine is waiting for a free conversation. */
  isQueued(id: string): boolean {
    return this.#queued.has(id);
  }

  /** Whether a run of this routine is in flight, INCLUDING one still waiting
   * (see {@link stateOf} for the distinction). */
  isBusy(id: string): boolean {
    return (this.#running.get(id) ?? 0) > 0 || this.#queued.has(id);
  }

  /** Where this routine's run is: idle, waiting, or running. */
  stateOf(id: string): RoutineRunState {
    if ((this.#running.get(id) ?? 0) > 0) return "running";
    return this.#queued.has(id) ? "queued" : "idle";
  }

  /** Take the one waiting slot for this routine. False when a run of it is
   * already waiting: that occurrence is one too many, and the next is
   * scheduled anyway. */
  beginWait(id: string): boolean {
    if (this.#queued.has(id)) return false;
    this.#queued.set(id, this.now());
    return true;
  }

  /** When the waiting run started waiting (for the bound on the wait). */
  waitingSince(id: string): number | undefined {
    return this.#queued.get(id);
  }

  /** The wait is over: the run is about to ask the agent. */
  beginRun(id: string): void {
    this.#queued.delete(id);
    this.#running.set(id, (this.#running.get(id) ?? 0) + 1);
  }

  /** The run ended, whether it started or never got that far. */
  endRun(id: string): void {
    this.#queued.delete(id);
    const left = (this.#running.get(id) ?? 0) - 1;
    if (left <= 0) this.#running.delete(id);
    else this.#running.set(id, left);
  }

  /** Mark the waiting run as cancelled, and say whether it was waiting.
   * The mark is consumed by the run when it notices (see {@link takeCancelled}). */
  cancelWaiting(id: string): boolean {
    if (!this.#queued.has(id)) return false;
    this.#cancelled.add(id);
    return true;
  }

  /** Consume the cancellation mark: true when this run was cancelled while it
   * waited, which is a one-time fact. */
  takeCancelled(id: string): boolean {
    return this.#cancelled.delete(id);
  }

  /** Mark the running run as stopped. Only the run this routine started is
   * stopped: the executor asks the runner, which checks the origin before
   * interrupting anything. */
  markRunningStopped(id: string): boolean {
    if ((this.#running.get(id) ?? 0) === 0) return false;
    this.#stopped.add(id);
    return true;
  }

  /** Consume the stop mark: true when the user stopped this run. */
  takeStopped(id: string): boolean {
    return this.#stopped.delete(id);
  }

  /** Drop a stop mark that no run consumed (a run that never started). */
  forgetStopped(id: string): void {
    this.#stopped.delete(id);
  }
}
