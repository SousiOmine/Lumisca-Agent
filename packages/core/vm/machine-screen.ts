/**
 * The screen side of the machine's per-agent state: whose desktop this process
 * started, the desktop start in flight, and the host port a pane connects to.
 *
 * A desktop is started at most once per container and only when somebody is
 * already at the screen: the pane asks for the port before the agent runs
 * anything, and a screenshot taken before the window manager is up would show
 * an empty screen. The record is dropped whenever the container behind it stops
 * or starts (see machine-agents.ts), so a machine that slept starts its desktop
 * again on the next look.
 *
 * The port is read fresh at every ask rather than remembered: it is assigned
 * when the container is created, so a container replaced by an image rebuild
 * has another one.
 */

import type { VmHost } from "./container.ts";

/** What asking for a port does to the machine before the port is read: the
 * caller counts as use and is woken, because a pane opened on a sleeping
 * machine is the user arriving at it. */
export interface ScreenCaller {
  touch(agentId: string): void;
  wake(agentId: string): Promise<void>;
}

export class AgentScreens {
  /** The agents whose desktop this server started since their container came
   * up. */
  #desktops = new Set<string>();
  /** The desktop start in flight per agent. */
  #starts = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      /** The host every machine shares, when one is attached. */
      currentHost: () => VmHost | undefined;
      /** The host, or the error saying there is none. */
      requireHost: () => VmHost;
      /** The machine state to touch and wake before a desktop is started. */
      caller: ScreenCaller;
    },
  ) {}

  /** Drop the record of one agent's desktop: its container is on its way out or
   * was just started, so whatever was up is gone. */
  forget(agentId: string): void {
    this.#desktops.delete(agentId);
    this.#starts.delete(agentId);
  }

  /** Drop every record (a different host was attached, or every machine was
   * stopped). */
  clear(): void {
    this.#desktops.clear();
    this.#starts.clear();
  }

  /** The host port of an agent's screen, waking the machine and starting its
   * desktop when the reader gets there before the agent does. Null without a
   * host. */
  async vncPortFor(agentId: string): Promise<number | null> {
    const host = this.options.currentHost();
    if (host === undefined) return null;
    this.options.caller.touch(agentId);
    await this.options.caller.wake(agentId);
    await this.ensureDesktop(agentId);
    return await host.machine(agentId).vncPort();
  }

  /** Start one agent's desktop unless this process already did. A second reader
   * waits for the start in flight rather than asking for a second window
   * manager. */
  async ensureDesktop(agentId: string): Promise<void> {
    if (this.#desktops.has(agentId)) return;
    const pending = this.#starts.get(agentId);
    if (pending !== undefined) {
      await pending;
      return;
    }
    const start = this.options
      .requireHost()
      .machine(agentId)
      .startDesktop()
      .then(() => {
        this.#desktops.add(agentId);
      })
      .finally(() => {
        this.#starts.delete(agentId);
      });
    this.#starts.set(agentId, start);
    await start;
  }
}
