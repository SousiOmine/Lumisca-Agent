/**
 * The idle sweep, on its own timer.
 *
 * A machine nobody used for the idle window is stopped, but up to
 * `VM_WARM_FLOOR` stay up so a conversation opened after a pause finds its
 * desktop already there (the policy is in machine-agents.ts). What belongs
 * here is only the timer: one pass at a time, an unref'd interval so a server
 * that is otherwise done can exit, and a failed pass that leaves the machines
 * as they were for the next tick to retry.
 *
 * `timer: false` turns the interval off and leaves `reap` to the caller, which
 * is how a test reaches its end without waiting.
 */

export class IdleReaper {
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: {
      intervalMs: number;
      timer: boolean;
      /** One pass. Never rejects: this catches what a pass throws. */
      reap: () => Promise<void>;
    },
  ) {}

  /** Start the interval, if this machine was built with one. A machine built
   * with `timer: false` starts nothing and leaves `reap` to its caller. */
  start(): void {
    if (!this.options.timer) return;
    const timer = setInterval(() => {
      void this.options.reap().catch(() => {
        // The reaper is housekeeping: a failed pass leaves the machines as
        // they were and the next pass tries again.
      });
    }, this.options.intervalMs);
    timer.unref?.();
    this.#timer = timer;
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
