/**
 * What the machine remembers about each agent's container between calls:
 * whether it is up, when it was last used, what is in flight, the start and
 * the stop on their way, and the queue that keeps a start and a stop from
 * interleaving.
 *
 * The machines are separate containers, so every one of these is keyed by
 * agent id. Nothing here decides whether a container exists: what exists is
 * what podman answers, and the reads belong to the machine (see machine.ts).
 * This is what the process knows and what it does with that knowledge — the
 * wake, the idle stop, the release and the removal all go through one queue per
 * agent.
 */

import type { VmHost } from "./container.ts";
import type { AgentScreens } from "./machine-screen.ts";

export class AgentMachines {
  /** Whether an agent's machine is known to be running. Undefined means "not
   * asked since this process started"; false means it was stopped (by idle
   * sleep, by a disable, or by a read that found it down). */
  #running = new Map<string, boolean>();
  /** When each agent's machine was last used, for the idle check. */
  #lastUse = new Map<string, number>();
  /** Commands in flight per agent: a machine with one is never stopped. */
  #active = new Map<string, number>();
  /** Open screen panes per agent: a machine somebody is watching is never
   * stopped for being idle, even when no tool has run in it for a while. */
  #watchers = new Map<string, number>();
  /** The start in flight per agent, shared by callers that race on a sleeping
   * machine. */
  #starting = new Map<string, Promise<void>>();
  /** The stop in flight per agent: a wake waits for it instead of starting a
   * container that is on its way out. */
  #stopping = new Map<string, Promise<void>>();
  /** One operation queue per agent, so a start and a stop never interleave. */
  #queues = new Map<string, Promise<unknown>>();
  /** True while an idle pass is stopping a machine: one pass at a time, so a
   * slow stop cannot let the next tick pick a second victim. */
  #reaping = false;

  constructor(
    private readonly options: {
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

  /** Drop every agent's state: a different host was attached, and another
   * installation has other containers. */
  clear(): void {
    this.#running.clear();
    this.#lastUse.clear();
    this.#active.clear();
    this.#watchers.clear();
    this.#starting.clear();
    this.#stopping.clear();
    this.#queues.clear();
  }

  /** Drop what stopping every machine leaves untrue. The queues and the
   * in-flight records stay: an operation already enqueued still has to run,
   * and the next wake waits for it. */
  forgetStopped(): void {
    this.#running.clear();
    this.#lastUse.clear();
    this.#watchers.clear();
  }

  /** Drop one agent's state (its machine was removed). */
  forget(agentId: string): void {
    this.#running.delete(agentId);
    this.#lastUse.delete(agentId);
    this.#active.delete(agentId);
    this.#watchers.delete(agentId);
    this.#starting.delete(agentId);
    this.#stopping.delete(agentId);
    this.#queues.delete(agentId);
    this.options.screens.forget(agentId);
  }

  /** What this process last read or decided about one machine; undefined when
   * it has not asked. */
  known(agentId: string): boolean | undefined {
    return this.#running.get(agentId);
  }

  /** Whether the agent's machine is known to be up. Undefined (never asked)
   * answers no. */
  knownRunning(agentId: string): boolean {
    return this.#running.get(agentId) === true;
  }

  /** Record what a read said, or what a start or stop just did. */
  setRunning(agentId: string, running: boolean): void {
    this.#running.set(agentId, running);
  }

  /** The machines as last read or decided, for the shutdown that asks each
   * running desktop to close first. */
  runningEntries(): [string, boolean][] {
    return [...this.#running];
  }

  /** Whether an agent's machine is being started right now. */
  isStarting(agentId: string): boolean {
    return this.#starting.has(agentId);
  }

  /** Note that an agent's machine was used. The idle clock starts here. */
  touch(agentId: string): void {
    this.#lastUse.set(agentId, this.options.now());
  }

  /** A screen pane opened on one agent: keep the machine warm while it is
   * open. The pane is the user looking at the desktop, so a machine with no
   * tool traffic is still in use. */
  watch(agentId: string): void {
    this.#watchers.set(agentId, (this.#watchers.get(agentId) ?? 0) + 1);
    this.touch(agentId);
  }

  /** A screen pane closed. The idle clock starts now, so closing the last pane
   * grants the usual window rather than stopping the machine at once. */
  unwatch(agentId: string): void {
    const count = this.#watchers.get(agentId);
    if (count === undefined) return;
    if (count > 1) {
      this.#watchers.set(agentId, count - 1);
      return;
    }
    this.#watchers.delete(agentId);
    this.touch(agentId);
  }

  /** Record one command in flight in an agent's machine. */
  enter(agentId: string): void {
    this.#active.set(agentId, (this.#active.get(agentId) ?? 0) + 1);
  }

  /** Record that a command finished (`enter` must have been called first). */
  leave(agentId: string): void {
    const left = (this.#active.get(agentId) ?? 0) - 1;
    if (left <= 0) this.#active.delete(agentId);
    else this.#active.set(agentId, left);
  }

  /** Bring one agent's machine up, starting it when it is not.
   *
   * Idempotent and safe to call concurrently: callers racing on a sleeping
   * machine share one start. */
  async wake(agentId: string): Promise<void> {
    const stopping = this.#stopping.get(agentId);
    if (stopping !== undefined) await stopping.catch(() => {});
    if (this.#running.get(agentId) === true) return;
    const starting = this.#starting.get(agentId);
    if (starting !== undefined) {
      await starting;
      return;
    }
    const start = this.#enqueue(agentId, async () => {
      if (this.#running.get(agentId) === true) return;
      const host = this.options.requireHost();
      await host.machine(agentId).start();
      this.#running.set(agentId, true);
      this.options.screens.forget(agentId);
      this.touch(agentId);
    }).finally(() => {
      this.#starting.delete(agentId);
    });
    this.#starting.set(agentId, start);
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
        this.#running.delete(victim);
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
      this.#running.set(agentId, false);
      this.#watchers.delete(agentId);
      this.options.screens.forget(agentId);
      await host.machine(agentId).stop();
      this.#lastUse.delete(agentId);
    }).catch(() => {
      // A machine that could not be stopped is not worth failing the disable
      // for: the row already says "disabled" and nothing will start it again.
      this.#running.delete(agentId);
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
   * `#running` is memory only. After a crash, containers with `--restart
   * unless-stopped` are still up, and the first reap would not know to count or
   * stop them. This reads each enabled agent once, in the background, and gives
   * the machines it finds the usual idle window from now. A machine this
   * process already knows better than the read is left alone, and a host
   * detached or replaced mid-scan ends the scan. */
  async reconcile(host: VmHost, agentIds: readonly string[]): Promise<void> {
    for (const agentId of agentIds) {
      if (this.options.currentHost() !== host) return;
      if (this.#settled(agentId)) continue;
      try {
        const status = await host.machine(agentId).status();
        if (this.options.currentHost() !== host) return;
        if (this.#settled(agentId)) continue;
        const running = status.state === "running";
        this.#running.set(agentId, running);
        if (running) this.#lastUse.set(agentId, this.options.now());
      } catch {
        this.#running.delete(agentId);
      }
    }
  }

  /** The machines that count as running: up plus starting. A start in flight
   * is one the warm floor must include, or two simultaneous starts could stop
   * a machine that the count said was still needed. */
  #runningCount(): number {
    const ids = new Set<string>();
    for (const [agentId, running] of this.#running) {
      if (running) ids.add(agentId);
    }
    for (const agentId of this.#starting.keys()) ids.add(agentId);
    return ids.size;
  }

  /** Whether a read has nothing to add to what this process already knows. */
  #settled(agentId: string): boolean {
    return (
      this.#running.has(agentId) ||
      this.#starting.has(agentId) ||
      this.#stopping.has(agentId)
    );
  }

  /** The least recently used machine that may be stopped for being idle now,
   * or undefined when every machine is in use. */
  #idleVictim(idleMs: number): string | undefined {
    const now = this.options.now();
    return [...this.#running]
      .filter(
        ([agentId, running]) => running && this.#idle(agentId, now, idleMs),
      )
      .map(([agentId]) => agentId)
      .sort(
        (a, b) => (this.#lastUse.get(a) ?? 0) - (this.#lastUse.get(b) ?? 0),
      )[0];
  }

  /** Whether one machine may be stopped for being idle now. */
  #idle(agentId: string, now: number, idleMs: number): boolean {
    if (this.#starting.has(agentId)) return false;
    if (this.#stopping.has(agentId)) return false;
    if (!this.#inUse(agentId)) return false;
    return now - (this.#lastUse.get(agentId) ?? 0) >= idleMs;
  }

  /** Whether nothing is keeping one machine up right now, leaving aside its
   * idle clock: a command in flight, a working conversation and a watched
   * screen all keep it up. */
  #inUse(agentId: string): boolean {
    if (this.#active.get(agentId) !== undefined) return false;
    if (this.options.busy()?.(agentId) === true) return false;
    if ((this.#watchers.get(agentId) ?? 0) > 0) return false;
    return true;
  }

  async #stopIdle(agentId: string): Promise<void> {
    if (this.#starting.has(agentId)) return;
    if (!this.#inUse(agentId)) return;
    const stop = this.#enqueue(agentId, async () => {
      if (this.#starting.has(agentId)) return;
      if (!this.#inUse(agentId)) return;
      const host = this.options.requireHost();
      this.#running.set(agentId, false);
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
      this.#lastUse.delete(agentId);
    });
    this.#stopping.set(agentId, stop);
    try {
      await stop;
    } finally {
      this.#stopping.delete(agentId);
    }
  }

  /** Run one operation after every operation already queued for the agent. */
  #enqueue<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(agentId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#queues.set(
      agentId,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }
}
