/**
 * Everything this process knows about each agent's machine, in one place.
 *
 * The machines are separate containers, so every fact below is keyed by agent
 * id — and the facts belong together: a container that starts drops the
 * desktop it was showing, a stop ends the use clock, a removal forgets the
 * skill catalog. Keeping them in one record per agent is what makes "this
 * agent's state starts here and ends here" a single place (`create` and
 * `drop`) instead of one line per map at every call site, where a new map is
 * one the stopping path forgets.
 *
 * Nothing here decides whether a container exists: what exists is what podman
 * answers, and the reads belong to the machine (see machine.ts). This is what
 * the process knows and what it does with that knowledge — the wake, the idle
 * stop, the release and the removal all go through one queue per agent.
 */

import type { SkillDef } from "../skills/discover.ts";

/** One agent's machine, as this process knows it. */
export interface AgentMachineState {
  // --- the container (machine-agents.ts) ---------------------------------

  /** Whether the machine is known to be running. Undefined means "not asked
   * since this process started"; false means it was stopped (by idle sleep,
   * by a disable, or by a read that found it down). */
  running: boolean | undefined;
  /** When the machine was last used, for the idle check. */
  lastUse: number | undefined;
  /** Commands in flight: a machine with one is never stopped. */
  active: number;
  /** Open screen panes: a machine somebody is watching is never stopped for
   * being idle, even when no tool has run in it for a while. */
  watchers: number;
  /** The start in flight, shared by callers that race on a sleeping
   * machine. */
  starting: Promise<void> | undefined;
  /** The stop in flight: a wake waits for it instead of starting a container
   * that is on its way out. */
  stopping: Promise<void> | undefined;
  /** The operation queue, so a start and a stop never interleave. */
  queue: Promise<unknown>;

  // --- the desktop (machine-screen.ts) -----------------------------------

  /** Whether this server started the desktop since the container came up. */
  desktop: boolean;
  /** The desktop start in flight. */
  desktopStarting: Promise<void> | undefined;

  // --- the skill catalog (machine-skills.ts) -----------------------------

  /** The catalog as last read, and when (undefined = never read). */
  skills: { defs: SkillDef[]; readAt: number } | undefined;
  /** The read in flight: `skills()` is called by every run and by the skill
   * tool, and a cold cache must start one read rather than one per call. */
  skillsRead: Promise<void> | undefined;
  /** When the last read failed, and how long a failure waits before it is
   * asked again (see SKILL_READ_RETRY_MS). */
  skillsRetryAt: number | undefined;
}

/** A machine's state that has not been asked anything yet. */
function freshState(): AgentMachineState {
  return {
    running: undefined,
    lastUse: undefined,
    active: 0,
    watchers: 0,
    starting: undefined,
    stopping: undefined,
    queue: Promise.resolve(),
    desktop: false,
    desktopStarting: undefined,
    skills: undefined,
    skillsRead: undefined,
    skillsRetryAt: undefined,
  };
}

/** What dropping one agent's state leaves behind, when something is still
 * running for it.
 *
 * A stop keeps the queue and the in-flight records: an operation already
 * enqueued still has to run, and the next wake waits for it. Everything that
 * describes what the container was doing is dropped, because a stopped
 * container has no desktop and no catalog that can be trusted. */
function stoppedState(state: AgentMachineState): AgentMachineState {
  return {
    ...freshState(),
    starting: state.starting,
    stopping: state.stopping,
    queue: state.queue,
  };
}

/**
 * The per-agent state of every machine, with the one place that creates and
 * drops it.
 *
 * Every read goes through {@link of}, which creates the record on first use:
 * a caller that only knows an agent id does not have to check whether the
 * machine has been seen before, and the record it gets is the one every other
 * caller sees. Every forgetful path goes through {@link drop} or
 * {@link dropAll}, so adding a fact to {@link AgentMachineState} cannot leave
 * a stopping path that keeps it.
 */
export class MachineStates {
  readonly #states = new Map<string, AgentMachineState>();

  constructor(
    private readonly options: {
      /** The clock the idle window is measured with (tests drive it by
       * hand). */
      now: () => number;
    },
  ) {}

  /** One agent's state, created on first use. */
  of(agentId: string): AgentMachineState {
    const known = this.#states.get(agentId);
    if (known !== undefined) return known;
    const state = freshState();
    this.#states.set(agentId, state);
    return state;
  }

  /** The state of an agent this process has never asked about, or
   * undefined. A read that must not create one (the version a list walks)
   * uses this. */
  known(agentId: string): AgentMachineState | undefined {
    return this.#states.get(agentId);
  }

  /** Every agent whose state this process holds. */
  entries(): [string, AgentMachineState][] {
    return [...this.#states];
  }

  /** Note that a machine was used. The idle clock starts here. */
  touch(agentId: string): void {
    this.of(agentId).lastUse = this.options.now();
  }

  /** Drop one agent's state because its container was removed: everything
   * this process knew about it is about a container that no longer exists. */
  drop(agentId: string): void {
    this.#states.delete(agentId);
  }

  /** Drop what stopping every machine leaves untrue, keeping the queues and
   * the in-flight records of the agents that had work: an operation already
   * enqueued still has to run, and the next wake waits for it. */
  dropStopped(): void {
    for (const [agentId, state] of this.#states) {
      this.#states.set(agentId, stoppedState(state));
    }
  }

  /** Drop every agent's state: a different host was attached, and another
   * installation has other containers. */
  dropAll(): void {
    this.#states.clear();
  }
}

/** Mutable facts a wake, a stop or a release leaves behind on the way out,
 * expressed as one call so the three cannot disagree about which of them a
 * stopped machine keeps. */
export function markStopped(state: AgentMachineState): void {
  state.running = false;
  state.lastUse = undefined;
  state.watchers = 0;
  state.desktop = false;
  state.desktopStarting = undefined;
}
