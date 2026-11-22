import { CoreError } from "../errors.ts";
import type { StellaStatus } from "../shared/wire.ts";
import type { SkillDef } from "../skills/discover.ts";
import { ensureAgentMemory } from "./agent-memory.ts";
import type { StellaAvailability } from "./availability.ts";
import { stellaAvailability } from "./availability.ts";
import type {
  VmChannelOpener,
  VmExec,
  VmExecBytes,
  VmHost,
  VmStatus,
} from "./container.ts";
import {
  VM_IDLE_SLEEP_MS,
  VM_REAP_INTERVAL_MS,
  VM_WARM_FLOOR,
} from "./contract.ts";
import { AgentMachines } from "./machine-agents.ts";
import { IdleReaper } from "./machine-reaper.ts";
import { AgentScreens } from "./machine-screen.ts";
import { type MachineRunners, MachineSeams } from "./machine-seams.ts";
import { AgentSkills } from "./machine-skills.ts";

/**
 * The stella machines: the host they share, what this process knows about each
 * agent's container, and the seams the backends reach one with.
 *
 * The machines are separate containers, so everything that used to be one
 * machine's state is keyed by agent id and lives in the module that owns its
 * question: the container's state and the operations that keep it up or down
 * (machine-agents.ts), the desktop and its port (machine-screen.ts), the exec
 * seams (machine-seams.ts), the skill catalogs (machine-skills.ts) and the
 * idle sweep's timer (machine-reaper.ts). Kept out of LumiscaCore because none
 * of it depends on sessions — the core only asks this for a runtime when it
 * opens a stella session.
 *
 * This class is what the server talks to. It answers with the host, decides
 * the availability verdict, and hands each seam out already wrapped so every
 * call wakes the machine and counts as use while it runs.
 */
export class StellaMachine {
  #host: VmHost | undefined;
  /** The availability verdict, cached until the next status read. */
  #verdict: StellaAvailability | undefined;
  /** Whether an agent's conversation is working right now, supplied by the
   * service that owns the sessions (the machine cannot see them). A machine
   * whose conversation is working is never stopped. */
  #busy: ((agentId: string) => boolean) | undefined;
  #idleMs: number;
  /** The number of machines kept running without use (see VM_WARM_FLOOR). */
  #warmFloor: number;
  readonly #screens: AgentScreens;
  readonly #agents: AgentMachines;
  readonly #seams: MachineSeams;
  readonly #skills: AgentSkills;
  readonly #reaper: IdleReaper;

  constructor(
    globalSkillDirs: string[] | undefined,
    /** Test seam: the runners behind the exec seams are replaced as a set, so
     * a test drives every command one way. */
    run?: MachineRunners | undefined,
    /** Test seam: the idle window, the clock and the reaper can be shortened
     * or driven by hand so a test reaches its end without waiting. */
    options: {
      idleMs?: number;
      /** Test seam: a test with one machine sets 0 to exercise the idle path
       * without starting four fillers. Production uses VM_WARM_FLOOR. */
      warmFloor?: number;
      now?: () => number;
      reapIntervalMs?: number;
      timer?: boolean;
    } = {},
  ) {
    this.#idleMs = options.idleMs ?? VM_IDLE_SLEEP_MS;
    this.#warmFloor = options.warmFloor ?? VM_WARM_FLOOR;
    const now = options.now ?? Date.now;
    // The three read each other through callbacks, which is what lets the
    // mutual facts (a wake drops a desktop, a port ask wakes the machine) stay
    // with the state they are about rather than passing through this class.
    this.#screens = new AgentScreens({
      currentHost: () => this.#host,
      requireHost: () => this.require(),
      // A pane asking for the port is the user arriving at the screen: it
      // counts as use and wakes the machine (see AgentScreens.vncPortFor).
      caller: {
        touch: (agentId) => this.#agents.touch(agentId),
        wake: (agentId) => this.#agents.wake(agentId),
      },
    });
    this.#agents = new AgentMachines({
      currentHost: () => this.#host,
      requireHost: () => this.require(),
      // Read on every check rather than captured: the service that owns the
      // sessions supplies it after this machine was built.
      busy: () => this.#busy,
      screens: this.#screens,
      now,
    });
    this.#seams = new MachineSeams({
      hasHost: () => this.#host !== undefined,
      runners: run,
      hooks: {
        enter: (agentId) => this.#agents.enter(agentId),
        leave: (agentId) => this.#agents.leave(agentId),
        touch: (agentId) => this.#agents.touch(agentId),
        wake: (agentId) => this.#agents.wake(agentId),
        ensureDesktop: (agentId) => this.#screens.ensureDesktop(agentId),
      },
    });
    this.#skills = new AgentSkills({
      globalSkillDirs,
      hasHost: () => this.#host !== undefined,
      isRunning: (agentId) => this.#agents.knownRunning(agentId),
      // No wake: a catalog read must not start a container (see
      // machine-skills.ts).
      exec: (agentId) => this.#seams.execWithoutWake(agentId),
    });
    this.#reaper = new IdleReaper({
      intervalMs: options.reapIntervalMs ?? VM_REAP_INTERVAL_MS,
      timer: options.timer ?? true,
      reap: () => this.reapIdle(),
    });
  }

  /** Supply the answer to "is this agent's conversation working?", which the
   * machine needs before it stops a machine. Called once by the service that
   * owns the sessions. */
  setBusyCheck(check: (agentId: string) => boolean): void {
    this.#busy = check;
  }

  /** Attach (or detach, with undefined) the host every machine shares. */
  set(host: VmHost | undefined): void {
    this.#reaper.stop();
    this.#host = host;
    // A new host invalidates the cached verdict (an image may have been built
    // since, or podman removed), every machine state, and the skill catalogs
    // (a different installation has different files).
    this.#verdict = undefined;
    this.#agents.clear();
    this.#screens.clear();
    this.#skills.clear();
    if (host !== undefined) this.#reaper.start();
  }

  get(): VmHost | undefined {
    return this.#host;
  }

  /** Whether stella mode can run here, with the reason when it cannot. Read
   * from the host's actual state, so installing podman or building the image
   * takes effect without a restart. */
  async availability(): Promise<StellaAvailability> {
    const host = this.#host;
    const verdict =
      host === undefined
        ? {
            available: false as const,
            code: "vm_not_set_up" as const,
            detail: "the virtual machine is not set up for this installation",
          }
        : stellaAvailability(await host.status());
    this.#verdict = verdict;
    return verdict;
  }

  /** The verdict recorded by the last availability read. */
  get verdict(): StellaAvailability | undefined {
    return this.#verdict;
  }

  /** Whether an image build is in flight (the one wait a first run shows). */
  get building(): boolean {
    return this.#host?.building ?? false;
  }

  /** Whether one agent's machine is being started right now. */
  isStarting(agentId: string): boolean {
    return this.#agents.isStarting(agentId);
  }

  /** Build the image when it is missing or stale, without starting any
   * machine. Opening a conversation does this so the first prompt does not
   * wait minutes for a build; it deliberately does not start a container. */
  async ensureImage(): Promise<void> {
    const host = this.require();
    await host.ensureImage();
    this.#verdict = undefined;
  }

  /**
   * Make sure one agent's machine is up, starting it when it is not.
   *
   * The path a prompt and a routine take, and the one place that ASKS rather
   * than trusts: a machine may have been stopped from outside (a crash, a
   * `podman stop` by hand) while this process believed it was running, and
   * every tool would then answer podman's "container state improper" for the
   * rest of the run. One fresh read per prompt is what that costs.
   *
   * Idempotent and safe to call concurrently: callers racing on a sleeping
   * machine share one start.
   */
  async ensureReady(agentId: string): Promise<void> {
    const host = this.require();
    const status = await host.machine(agentId).status({ fresh: true });
    const wasRunning = status.state === "running";
    this.#agents.setRunning(agentId, wasRunning);
    await this.#agents.wake(agentId);
    if (!wasRunning) {
      // The machine just came up: its working folder does not exist yet, and
      // a run's first `bash` would fail on the missing workdir. Done here
      // rather than on every prompt because a wake is the only moment it can
      // be missing.
      await this.ensureAgentFolder(agentId);
    }
    this.#agents.touch(agentId);
  }

  /** Whether an agent's machine is up, as the last read the client already
   * polls saw: no `fresh` bypass, so a read made within the cache window is
   * free.
   *
   * This is the cheap question opening a conversation asks — "is this
   * machine still there?" — not the expensive one (`ensureReady`, which
   * starts it). Opening a conversation must not wake a sleeping machine: a
   * user browsing the sidebar would pay a browser for every row they looked
   * at. */
  async isRunning(agentId: string): Promise<boolean> {
    const host = this.#host;
    if (host === undefined) return false;
    const known = this.#agents.known(agentId);
    if (known !== undefined) return known;
    const status = await host.machine(agentId).status();
    const running = status.state === "running";
    this.#agents.setRunning(agentId, running);
    if (running) this.#agents.touch(agentId);
    return running;
  }

  /** One agent's machine, as the status endpoint reports it. */
  async machineStatus(agentId: string): Promise<VmStatus | undefined> {
    const host = this.#host;
    if (host === undefined) return undefined;
    const status = await host.machine(agentId).status();
    this.#agents.setRunning(agentId, status.state === "running");
    return status;
  }

  /** The machine's state for the status endpoint: the installation-level
   * availability, and whether something is being prepared. */
  async status(): Promise<StellaStatus> {
    const host = this.#host;
    if (host === undefined) {
      const availability = await this.availability();
      return {
        availability,
        starting: false,
        reason: availability.available ? "" : availability.detail,
      };
    }
    const shared = await host.status({ fresh: true });
    const availability = stellaAvailability(shared);
    this.#verdict = availability;
    return {
      availability,
      // The installation-level wait: the image being built. A machine being
      // started is that agent's own state (`machineStatus`), which the
      // conversation polls.
      starting: this.building,
      reason: shared.reason,
    };
  }

  /** Stop every machine this process knows, by `podman stop`. Called on
   * shutdown only.
   *
   * The desktop is asked to close first: `podman stop` ends the container's
   * processes, and a browser killed that way is more likely to lose the
   * session it would restore on the next start. */
  async stopAll(): Promise<void> {
    this.#reaper.stop();
    const host = this.#host;
    try {
      if (host !== undefined) {
        for (const [agentId, running] of this.#agents.runningEntries()) {
          if (!running) continue;
          try {
            await host.machine(agentId).stopDesktop();
          } catch {
            // The container stop below is the real stop; a desktop that
            // cannot be asked to close must not keep it up.
          }
        }
        await host.stopAll();
      }
    } finally {
      this.#verdict = undefined;
      this.#agents.forgetStopped();
      this.#screens.clear();
    }
  }

  /** Stop one agent's machine now (the agent was switched off). The caller
   * has already ended the conversation's run, so nothing may keep working in
   * a machine nobody can open. */
  async release(agentId: string): Promise<void> {
    const host = this.#host;
    if (host === undefined) return;
    await this.#agents.release(agentId, host);
  }

  /** Remove one agent's container (the agent was deleted). Its home stays on
   * the shared volume. */
  async remove(agentId: string): Promise<void> {
    const host = this.#host;
    if (host === undefined) return;
    await this.#agents.removeContainer(agentId, host);
    this.#agents.forget(agentId);
    this.#skills.forget(agentId);
  }

  /** Note that an agent's machine was used. The idle clock starts here. */
  touch(agentId: string): void {
    this.#agents.touch(agentId);
  }

  /** A screen pane opened on one agent: keep the machine warm while it is
   * open. The pane is the user looking at the desktop, so a machine with no
   * tool traffic is still in use. */
  watch(agentId: string): void {
    this.#agents.watch(agentId);
  }

  /** A screen pane closed. The idle clock starts now, so closing the last
   * pane grants the usual window rather than stopping the machine at once. */
  unwatch(agentId: string): void {
    this.#agents.unwatch(agentId);
  }

  /** Adopt the machines a previous process left running (see
   * AgentMachines.reconcile). A host detached or replaced mid-scan ends it. */
  async reconcile(agentIds: readonly string[]): Promise<void> {
    const host = this.#host;
    if (host === undefined) return;
    await this.#agents.reconcile(host, agentIds);
  }

  /** Stop the machines above the warm floor whose agent has not used them for
   * the idle window (see AgentMachines.reapIdle). Called on a timer and from
   * the tests directly. */
  async reapIdle(): Promise<void> {
    if (this.#host === undefined) return;
    await this.#agents.reapIdle(this.#warmFloor, this.#idleMs);
  }

  /** The host port of an agent's screen, waking the machine and starting its
   * desktop when the reader gets there before the agent does (see
   * AgentScreens.vncPortFor). */
  async vncPortFor(agentId: string): Promise<number | null> {
    return await this.#screens.vncPortFor(agentId);
  }

  /**
   * One agent's exec seam: every call wakes the machine first.
   *
   * The file tools, the shell and a background command take this seam. The
   * screen tools take {@link screenExec}, which also starts the desktop, and
   * the skill reads take an unwoken one, because reading a catalog must not
   * start a container. All of them carry the container's own `DISPLAY` and
   * session bus, which `podman exec` inherits from the container.
   */
  exec(agentId: string): VmExec | undefined {
    return this.#seams.exec(agentId);
  }

  /** The byte variant of {@link exec} (a screen capture). */
  execBytes(agentId: string): VmExecBytes | undefined {
    return this.#seams.execBytes(agentId);
  }

  /** The screen seam: wakes the machine and starts its desktop first. */
  screenExec(agentId: string): VmExec | undefined {
    return this.#seams.screenExec(agentId);
  }

  /** The byte variant of {@link screenExec}. */
  screenExecBytes(agentId: string): VmExecBytes | undefined {
    return this.#seams.screenExecBytes(agentId);
  }

  /** The interactive seam of one machine (the scripting tool call). */
  channel(agentId: string): VmChannelOpener | undefined {
    return this.#seams.channel(agentId);
  }

  /** The machine, or an error saying there is none. */
  require(): VmHost {
    if (this.#host === undefined) {
      throw new CoreError(
        "stella mode is not available: the virtual machine is not set up for " +
          "this installation",
        "unavailable",
      );
    }
    return this.#host;
  }

  /** Create the agent's working folder inside the machine and leave an empty
   * MEMORY.md in it (idempotent: an existing file is never emptied). */
  async ensureAgentFolder(agentId: string): Promise<void> {
    const exec = this.exec(agentId);
    if (exec === undefined) return;
    await ensureAgentMemory(exec, agentId);
  }

  /** Re-read one agent's skill catalog: the agent's own skills, the
   * machine-wide folder, and the user's global and built-in set. */
  async refreshSkills(agentId: string): Promise<void> {
    await this.#skills.refresh(agentId);
  }

  /** Read one agent's catalog when this server has not read it yet (see
   * AgentSkills.ensure). Separate from {@link refreshSkills}, which reads
   * unconditionally: a conversation that opens wants skills the agent wrote
   * since the last read, while a run that is already under way only needs an
   * empty cache to stop being empty. */
  async ensureSkills(agentId: string): Promise<void> {
    await this.#skills.ensure(agentId);
  }

  /** One agent's catalog as last read (the factory builds tools
   * synchronously). Empty until the agent's first read, and a cold cache on a
   * running machine starts one (see AgentSkills.skills). */
  skills(agentId: string): SkillDef[] {
    return this.#skills.skills(agentId);
  }

  /** Wake one agent's machine without waiting for a tool call (the pane's
   * "wake" button). */
  async wake(agentId: string): Promise<void> {
    await this.ensureReady(agentId);
  }
}
