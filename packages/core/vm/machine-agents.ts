/**
 * What the machine does with what it knows about each agent's container:
 * whether it is up, when it was last used, what is in flight, the start and
 * the stop on their way, and the queue that keeps a start and a stop from
 * interleaving.
 *
 * The state itself lives in one record per agent (see machine-state.ts); this
 * class is the policy over it — the wake, the idle stop, the release and the
 * removal all go through one queue per agent. Nothing here decides whether a
 * container exists: what exists is what podman answers, and the reads belong
 * to the machine (see machine.ts).
 */

import type { VmHost } from "./container.ts";
import type { AgentScreens } from "./machine-screen.ts";
import type { MachineStates } from "./machine-state.ts";
import { markStopped } from "./machine-state.ts";

export class AgentMachines {
  constructor(
    private readonly options: {
      /** The per-agent state, created and dropped in one place. */
      states: MachineStates;
      /** The host every machine shares, when one is attached. */
      currentHost: () => VmHost | undefined;
      /** The host, or the error saying there is none. */
      requireHost: () => VmHost;
      /** Whether an agent's conversation is working right now, supplied by the
       * service that owns the sessions (see StellaMachine.setBusyCheck). A
       * machine whose conversation is working is never stopped. */
      busy: () => ((agentId: string) => boolean) | undefined;
      /** The desktops to drop whenever a container starts or stops: a
       * restarted container has no window manager. */
      screens: AgentScreens;
      /** The clock the idle window is measured with (tests drive it by hand). */
      now: () => number;
    },
  ) {}

  /** Whether the agent's machine is known to be up. Undefined (never asked)
   * answers no. */
  knownRunning(agentId: string): boolean {
    return this.options.states.known(agentId)?.running === true;
  }

  /** What this process last read or decided about one machine; undefined when
   * it has not asked. */
  known(agentId: string): boolean | undefined {
    return this.options.states.known(agentId)?.running;
  }

  /** Record what a read said, or what a start or stop just did. */
  setRunning(agentId: string, running: boolean): void {
    this.options.states.of(agentId).running = running;
  }

  /** The machines as last read or decided, for the shutdown that asks each
   * running desktop to close first. */
  runningEntries(): [string, boolean][] {
    return this.options.states
      .entries()
      .filter(([, state]) => state.running !== undefined)
      .map(([agentId, state]) => [agentId, state.running === true]);
  }

  /** Whether an agent's machine is being started right now. */
  isStarting(agentId: string): boolean {
    return this.options.states.known(agentId)?.starting !== undefined;
  }

  /** Note that an agent's machine was used. The idle clock starts here. */
  touch(agentId: string): void {
    this.options.states.touch(agentId);
  }

  /** A screen pane opened on one agent: keep the machine warm while it is
   * open. The pane is the user looking at the desktop, so a machine with no
   * tool traffic is still in use. */
  watch(agentId: string): void {
    const state = this.options.states.of(agentId);
    state.watchers += 1;
    this.touch(agentId);
  }

  /** A screen pane closed. The idle clock starts now, so closing the last pane
   * grants the usual window rather than stopping the machine at once. */
  unwatch(agentId: string): void {
    const state = this.options.states.known(agentId);
    if (state === undefined || state.watchers === 0) return;
    state.watchers -= 1;
    if (state.watchers === 0) this.touch(agentId);
  }

  /** Record one command in flight in an agent's machine. */
  enter(agentId: string): void {
    this.options.states.of(agentId).active += 1;
  }

  /** Record that a command finished (`enter` must have been called first). */
  leave(agentId: string): void {
    const state = this.options.states.known(agentId);
    if (state === undefined || state.active === 0) return;
    state.active -= 1;
  }

  /** Bring one agent's machine up, starting it when it is not.
   *
   * Idempotent and safe to call concurrently: callers racing on a sleeping
   * machine share one start. */
  async wake(agentId: string): Promise<void> {
    const state = this.options.states.of(agentId);
    if (state.stopping !== undefined) await state.stopping.catch(() => {});
    if (state.running === true) return;
    if (state.starting !== undefined) {
      await state.starting;
      return;
    }
    const start = this.#enqueue(agentId, async () => {
      if (state.running === true) return;
      const host = this.options.requireHost();
      await host.machine(agentId).start();
      state.running = true;
      this.options.screens.forget(agentId);
      this.touch(agentId);
    }).finally(() => {
      state.starting = undefined;
    });
    state.starting = start;
    await start;
  }

  /**
   * Stop the machines above the warm floor whose agent has not used them for
   * the idle window.
   *
   * Up to `warmFloor` machines stay running: a conversation opened after a
   * pause finds its desktop already there. Above the floor, the least recently
   * used idle machine is stopped, one per pass. A machine whose conversation is
   * working, whose exec is in flight, whose background command is still
   * running, or whose screen somebody is watching is left alone: stopping it
   * would kill work in progress or the screen in front of the user.
   */
  async reapIdle(warmFloor: number, idleMs: number): Promise<void> {
    if (this.#reaping) return;
    if (this.#runningCount() <= warmFloor) return;
    this.#reaping = true;
    try {
      const victim = this.#idleVictim(idleMs);
      if (victim === undefined) return;
      try {
        await this.#stopIdle(victim);
      } catch {
        // The state is unknown now: the next call asks podman instead of
        // trusting a machine that refused to stop.
        const state = this.options.states.known(victim);
        if (state !== undefined) state.running = undefined;
      }
    } finally {
      this.#reaping = false;
    }
  }

  /** Stop one agent's machine now (the agent was switched off). The caller has
   * already ended the conversation's run, so nothing may keep working in a
   * machine nobody can open. */
  async release(agentId: string, host: VmHost): Promise<void> {
    await this.#enqueue(agentId, async () => {
      const state = this.options.states.of(agentId);
      markStopped(state);
      this.options.screens.forget(agentId);
      await host.machine(agentId).stop();
    }).catch(() => {
      // A machine that could not be stopped is not worth failing the disable
      // for: the row already says "disabled" and nothing will start it again.
      const state = this.options.states.known(agentId);
      if (state !== undefined) state.running = undefined;
    });
  }

  /** Remove one agent's container (the agent was deleted), behind every
   * operation already queued for it. Its home stays on the shared volume; the
   * caller forgets the agent after this. */
  async removeContainer(agentId: string, host: VmHost): Promise<void> {
    await this.#enqueue(agentId, async () => {
      await host.machine(agentId).remove();
    });
  }

  /** Adopt the machines a previous process left running.
   *
   * The running flag is memory only, and this record is created by the first
   * read. After a crash, containers with `--restart unless-stopped` are still
   * up, and the first reap would not know to count or stop them. This reads
   * each enabled agent once, in the background, and gives the machines it finds
   * the usual idle window from now. A machine this process already knows
   * better than the read is left alone, and a host detached or replaced
   * mid-scan ends the scan. */
  async reconcile(host: VmHost, agentIds: readonly string[]): Promise<void> {
    for (const agentId of agentIds) {
      if (this.options.currentHost() !== host) return;
      if (this.#settled(agentId)) continue;
      const state = this.options.states.of(agentId);
      try {
        const status = await host.machine(agentId).status();
        if (this.options.currentHost() !== host) return;
        if (this.#settled(agentId)) continue;
        const running = status.state === "running";
        state.running = running;
        if (running) this.touch(agentId);
      } catch {
        state.running = undefined;
      }
    }
  }

  /** True while an idle pass is stopping a machine: one pass at a time, so a
   * slow stop cannot let the next tick pick a second victim. */
  #reaping = false;

  /** The machines that count as running: up plus starting. A start in flight
   * is one the warm floor must include, or two simultaneous starts could stop
   * a machine that the count said was still needed. */
  #runningCount(): number {
    let count = 0;
    for (const [, state] of this.options.states.entries()) {
      if (state.running === true || state.starting !== undefined) count++;
    }
    return count;
  }

  /** Whether a read has nothing to add to what this process already knows. */
  #settled(agentId: string): boolean {
    const state = this.options.states.known(agentId);
    if (state === undefined) return false;
    return (
      state.running !== undefined ||
      state.starting !== undefined ||
      state.stopping !== undefined
    );
  }

  /** The least recently used machine that may be stopped for being idle now,
   * or undefined when every machine is in use. */
  #idleVictim(idleMs: number): string | undefined {
    const now = this.options.now();
    return this.options.states
      .entries()
      .filter(
        ([agentId, state]) =>
          state.running === true && this.#idle(agentId, now, idleMs),
      )
      .map(([agentId]) => agentId)
      .sort(
        (a, b) =>
          (this.options.states.known(a)?.lastUse ?? 0) -
          (this.options.states.known(b)?.lastUse ?? 0),
      )[0];
  }

  /** Whether one machine may be stopped for being idle now. */
  #idle(agentId: string, now: number, idleMs: number): boolean {
    const state = this.options.states.known(agentId);
    if (state === undefined) return false;
    if (state.starting !== undefined) return false;
    if (state.stopping !== undefined) return false;
    if (!this.#inUse(agentId)) return false;
    return now - (state.lastUse ?? 0) >= idleMs;
  }

  /** Whether nothing is keeping one machine up right now, leaving aside its
   * idle clock: a command in flight, a working conversation and a watched
   * screen all keep it up. */
  #inUse(agentId: string): boolean {
    const state = this.options.states.known(agentId);
    if (state === undefined) return false;
    if (state.active > 0) return false;
    if (this.options.busy()?.(agentId) === true) return false;
    if (state.watchers > 0) return false;
    return true;
  }

  async #stopIdle(agentId: string): Promise<void> {
    const state = this.options.states.of(agentId);
    if (state.starting !== undefined) return;
    if (!this.#inUse(agentId)) return;
    const stop = this.#enqueue(agentId, async () => {
      if (state.starting !== undefined) return;
      if (!this.#inUse(agentId)) return;
      const host = this.options.requireHost();
      markStopped(state);
      this.options.screens.forget(agentId);
      // Close the desktop first: Chromium receives SIGTERM and writes the
      // session the next start restores. A desktop that is already down
      // answers as a no-op.
      try {
        await host.machine(agentId).stopDesktop();
      } catch {
        // The container stop below is the real stop.
      }
      await host.machine(agentId).stop();
    });
    state.stopping = stop;
    try {
      await stop;
    } finally {
      state.stopping = undefined;
    }
  }

  /** Run one operation after every operation already queued for the agent. */
  #enqueue<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const state = this.options.states.of(agentId);
    const next = state.queue.then(fn, fn);
    state.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}
