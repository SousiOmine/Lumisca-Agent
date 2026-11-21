import type { StellaStatus } from "../shared/wire.ts";
import { builtinSkills } from "../skills/builtin/mod.ts";
import type { SkillDef } from "../skills/discover.ts";
import { ensureAgentMemory } from "./agent-memory.ts";
import type { StellaAvailability } from "./availability.ts";
import { stellaAvailability } from "./availability.ts";
import { openVmChannel, type VmChannelRunner } from "./channel.ts";
import type { VmCommandBytesRunner, VmCommandRunner } from "./command.ts";
import { runVmCommand, runVmCommandBytes } from "./command.ts";
import type {
  VmChannelOpener,
  VmExec,
  VmExecBytes,
  VmHost,
  VmStatus,
} from "./container.ts";
import {
  createVmChannel,
  createVmExec,
  createVmExecBytes,
} from "./container.ts";
import {
  VM_IDLE_SLEEP_MS,
  VM_REAP_INTERVAL_MS,
  VM_SKILLS_DIR,
  VM_WARM_FLOOR,
  vmContainerName,
} from "./contract.ts";
import { discoverVmSkills } from "./skills.ts";

/** How long a failed skill catalog read waits before it is asked again.
 *
 * A read is started from inside a run when the catalog is cold (see
 * `ensureSkills`), so a machine that is not answering would otherwise be
 * asked once per run and once per `skill` call. A container restart is what
 * makes a read fail, and it takes seconds: this is long enough that a broken
 * machine is not hammered and short enough that the turn after a restart
 * finds the skills. */
const SKILL_READ_RETRY_MS = 30_000;

/** Everything the stella machines hold between calls: the host, one manager
 * per agent, the cached availability verdict and the skill catalogs.
 *
 * The machines are separate containers, so everything that used to be one
 * machine's state — which agent's desktop is up, when a machine was last used,
 * what is running in it — is keyed by agent id. Kept out of LumiscaCore
 * because none of it depends on sessions — the core only asks this for a
 * runtime when it opens a stella session. */
export class StellaMachine {
  #host: VmHost | undefined;
  /** The availability verdict, cached until the next status read. */
  #verdict: StellaAvailability | undefined;
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
  /** The agents whose desktop this server started since the container came
   * up. Cleared whenever the container is stopped or started. */
  #desktops = new Set<string>();
  /** The desktop start in flight per agent. */
  #desktopStarts = new Map<string, Promise<void>>();
  /** The skill catalogs, one per stella agent (keyed by agent id), refreshed
   * before each open. A catalog is per agent because an agent's own skills
   * live in its folder: only the machine-wide folder is shared. */
  #skills = new Map<string, SkillDef[]>();
  /** The catalog reads in flight, one per agent: `skills()` is called by
   * every run and by the skill tool, and a cold cache must start one read
   * rather than one per call. */
  #skillReads = new Map<string, Promise<void>>();
  /** When each agent's last read failed (see SKILL_READ_RETRY_MS). */
  #skillRetries = new Map<string, number>();
  /** Whether an agent's conversation is working right now, supplied by the
   * service that owns the sessions (the machine cannot see them). A machine
   * whose conversation is working is never stopped. */
  #busy: ((agentId: string) => boolean) | undefined;
  /** The idle reaper, started when a host is attached. */
  #reaper: ReturnType<typeof setInterval> | undefined;
  /** True while a reap pass is stopping a machine: one pass at a time, so a
   * slow stop cannot let the next tick pick a second victim. */
  #reaping = false;
  #idleMs: number;
  /** The number of machines kept running without use (see VM_WARM_FLOOR). */
  #warmFloor: number;
  #reapIntervalMs: number;
  #now: () => number;
  #timer: boolean;

  constructor(
    private readonly globalSkillDirs: string[] | undefined,
    private readonly run?:
      | {
          run: VmCommandRunner;
          runBytes: VmCommandBytesRunner;
          openChannel?: VmChannelRunner;
        }
      | undefined,
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
    this.#reapIntervalMs = options.reapIntervalMs ?? VM_REAP_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#timer = options.timer ?? true;
  }

  /** Supply the answer to "is this agent's conversation working?", which the
   * machine needs before it stops a machine. Called once by the service that
   * owns the sessions. */
  setBusyCheck(check: (agentId: string) => boolean): void {
    this.#busy = check;
  }

  /** Attach (or detach, with undefined) the host every machine shares. */
  set(host: VmHost | undefined): void {
    this.#stopReaper();
    this.#host = host;
    // A new host invalidates the cached verdict (an image may have been built
    // since, or podman removed), every machine state, and the skill catalogs
    // (a different installation has different files).
    this.#verdict = undefined;
    this.#running.clear();
    this.#lastUse.clear();
    this.#active.clear();
    this.#watchers.clear();
    this.#starting.clear();
    this.#stopping.clear();
    this.#queues.clear();
    this.#desktops.clear();
    this.#desktopStarts.clear();
    this.#skills.clear();
    this.#skillReads.clear();
    this.#skillRetries.clear();
    if (host !== undefined) this.#startReaper();
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
            reason:
              "stella mode is not available: the virtual machine is not set up " +
              "for this installation",
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
    return this.#starting.has(agentId);
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
    this.#running.set(agentId, wasRunning);
    await this.#ensureAwake(agentId);
    if (!wasRunning) {
      // The machine just came up: its working folder does not exist yet, and
      // a run's first `bash` would fail on the missing workdir. Done here
      // rather than on every prompt because a wake is the only moment it can
      // be missing.
      await this.ensureAgentFolder(agentId);
    }
    this.touch(agentId);
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
    const known = this.#running.get(agentId);
    if (known !== undefined) return known;
    const status = await host.machine(agentId).status();
    const running = status.state === "running";
    this.#running.set(agentId, running);
    if (running) this.touch(agentId);
    return running;
  }

  /** One agent's machine, as the status endpoint reports it. */
  async machineStatus(agentId: string): Promise<VmStatus | undefined> {
    const host = this.#host;
    if (host === undefined) return undefined;
    const status = await host.machine(agentId).status();
    this.#running.set(agentId, status.state === "running");
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
        reason: availability.available ? "" : availability.reason,
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
    this.#stopReaper();
    const host = this.#host;
    try {
      if (host !== undefined) {
        for (const [agentId, running] of [...this.#running]) {
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
      this.#running.clear();
      this.#lastUse.clear();
      this.#watchers.clear();
      this.#desktops.clear();
      this.#desktopStarts.clear();
    }
  }

  /** Stop one agent's machine now (the agent was switched off). The caller
   * has already ended the conversation's run, so nothing may keep working in
   * a machine nobody can open. */
  async release(agentId: string): Promise<void> {
    const host = this.#host;
    if (host === undefined) return;
    await this.#enqueue(agentId, async () => {
      this.#running.set(agentId, false);
      this.#watchers.delete(agentId);
      this.#desktops.delete(agentId);
      this.#desktopStarts.delete(agentId);
      await host.machine(agentId).stop();
      this.#lastUse.delete(agentId);
    }).catch(() => {
      // A machine that could not be stopped is not worth failing the disable
      // for: the row already says "disabled" and nothing will start it again.
      this.#running.delete(agentId);
    });
  }

  /** Remove one agent's container (the agent was deleted). Its home stays on
   * the shared volume. */
  async remove(agentId: string): Promise<void> {
    const host = this.#host;
    if (host === undefined) return;
    await this.#enqueue(agentId, async () => {
      await host.machine(agentId).remove();
    });
    this.#forget(agentId);
  }

  /** Note that an agent's machine was used. The idle clock starts here. */
  touch(agentId: string): void {
    this.#lastUse.set(agentId, this.#now());
  }

  /** A screen pane opened on one agent: keep the machine warm while it is
   * open. The pane is the user looking at the desktop, so a machine with no
   * tool traffic is still in use. */
  watch(agentId: string): void {
    this.#watchers.set(agentId, (this.#watchers.get(agentId) ?? 0) + 1);
    this.touch(agentId);
  }

  /** A screen pane closed. The idle clock starts now, so closing the last
   * pane grants the usual window rather than stopping the machine at once. */
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

  /** Adopt the machines a previous process left running.
   *
   * `#running` is memory only. After a crash, containers with `--restart
   * unless-stopped` are still up, and the first reap would not know to count
   * or stop them. This reads each enabled agent once, in the background, and
   * gives the machines it finds the usual idle window from now. A machine
   * this process already knows better than the read is left alone. */
  async reconcile(agentIds: readonly string[]): Promise<void> {
    const host = this.#host;
    if (host === undefined) return;
    for (const agentId of agentIds) {
      if (this.#host !== host) return;
      if (
        this.#running.has(agentId) ||
        this.#starting.has(agentId) ||
        this.#stopping.has(agentId)
      ) {
        continue;
      }
      try {
        const status = await host.machine(agentId).status();
        if (this.#host !== host) return;
        if (
          this.#running.has(agentId) ||
          this.#starting.has(agentId) ||
          this.#stopping.has(agentId)
        ) {
          continue;
        }
        const running = status.state === "running";
        this.#running.set(agentId, running);
        if (running) this.#lastUse.set(agentId, this.#now());
      } catch {
        this.#running.delete(agentId);
      }
    }
  }

  /** Stop the machines above the warm floor whose agent has not used them
   * for the idle window.
   *
   * Up to `VM_WARM_FLOOR` machines stay running: a conversation opened after
   * a pause finds its desktop already there. Above the floor, the least
   * recently used idle machine is stopped, one per pass. A machine whose
   * conversation is working, whose exec is in flight, whose background
   * command is still running, or whose screen somebody is watching is left
   * alone: stopping it would kill work in progress or the screen in front of
   * the user. Called on a timer and from the tests directly. */
  async reapIdle(): Promise<void> {
    if (this.#host === undefined) return;
    if (this.#reaping) return;
    if (this.#runningCount() <= this.#warmFloor) return;
    this.#reaping = true;
    try {
      const now = this.#now();
      const victim = [...this.#running]
        .filter(([agentId, running]) => running && this.#idle(agentId, now))
        .map(([agentId]) => agentId)
        .sort(
          (a, b) => (this.#lastUse.get(a) ?? 0) - (this.#lastUse.get(b) ?? 0),
        )[0];
      if (victim === undefined) return;
      try {
        await this.#sleep(victim);
      } catch {
        // The state is unknown now: the next call asks podman instead of
        // trusting a machine that refused to stop.
        this.#running.delete(victim);
      }
    } finally {
      this.#reaping = false;
    }
  }

  /** The machines that count as running: up plus starting. A start in
   * flight is one the floor must include, or two simultaneous starts could
   * stop a machine that the count said was still needed. */
  #runningCount(): number {
    const ids = new Set<string>();
    for (const [agentId, running] of this.#running) {
      if (running) ids.add(agentId);
    }
    for (const agentId of this.#starting.keys()) ids.add(agentId);
    return ids.size;
  }

  /** Whether one machine may be stopped for being idle now. */
  #idle(agentId: string, now: number): boolean {
    if (this.#starting.has(agentId)) return false;
    if (this.#stopping.has(agentId)) return false;
    if (this.#active.get(agentId) !== undefined) return false;
    if (this.#busy?.(agentId) === true) return false;
    if ((this.#watchers.get(agentId) ?? 0) > 0) return false;
    return now - (this.#lastUse.get(agentId) ?? 0) >= this.#idleMs;
  }

  /** The host port of an agent's screen, waking the machine and starting its
   * desktop when the reader gets there before the agent does. */
  async vncPortFor(agentId: string): Promise<number | null> {
    const host = this.#host;
    if (host === undefined) return null;
    this.touch(agentId);
    await this.#ensureAwake(agentId);
    await this.#ensureDesktop(agentId);
    return await host.machine(agentId).vncPort();
  }

  /**
   * One agent's exec seam: every call wakes the machine first.
   *
   * The file tools, the shell, a background command and the skill reads take
   * this seam. The screen tools take {@link screenExec}, which also starts the
   * desktop. Both carry the container's own `DISPLAY` and session bus, which
   * `podman exec` inherits from the container.
   */
  exec(agentId: string): VmExec | undefined {
    const base = this.#execSeam(agentId);
    if (base === undefined) return undefined;
    return async (command, exec) => {
      this.#enter(agentId);
      try {
        this.touch(agentId);
        await this.#ensureAwake(agentId);
        return await base(command, exec);
      } finally {
        this.#leave(agentId);
      }
    };
  }

  /** The byte variant of {@link exec} (a screen capture). */
  execBytes(agentId: string): VmExecBytes | undefined {
    const base = this.#execBytesSeam(agentId);
    if (base === undefined) return undefined;
    return async (command, exec) => {
      this.#enter(agentId);
      try {
        this.touch(agentId);
        await this.#ensureAwake(agentId);
        return await base(command, exec);
      } finally {
        this.#leave(agentId);
      }
    };
  }

  /** The screen seam: wakes the machine and starts its desktop first. */
  screenExec(agentId: string): VmExec | undefined {
    const base = this.#execSeam(agentId);
    if (base === undefined) return undefined;
    return async (command, exec) => {
      this.#enter(agentId);
      try {
        this.touch(agentId);
        await this.#ensureAwake(agentId);
        await this.#ensureDesktop(agentId);
        return await base(command, exec);
      } finally {
        this.#leave(agentId);
      }
    };
  }

  /** The byte variant of {@link screenExec}. */
  screenExecBytes(agentId: string): VmExecBytes | undefined {
    const base = this.#execBytesSeam(agentId);
    if (base === undefined) return undefined;
    return async (command, exec) => {
      this.#enter(agentId);
      try {
        this.touch(agentId);
        await this.#ensureAwake(agentId);
        await this.#ensureDesktop(agentId);
        return await base(command, exec);
      } finally {
        this.#leave(agentId);
      }
    };
  }

  /** The interactive seam of one machine (the scripting tool call). */
  channel(agentId: string): VmChannelOpener | undefined {
    const seam = this.#seams(agentId);
    if (seam === undefined) return undefined;
    return async (command, exec) => {
      this.#enter(agentId);
      try {
        this.touch(agentId);
        await this.#ensureAwake(agentId);
        return await seam.channel(command, exec);
      } finally {
        this.#leave(agentId);
      }
    };
  }

  /** The machine, or an error saying there is none. */
  require(): VmHost {
    if (this.#host === undefined) {
      throw new Error(
        "stella mode is not available: the virtual machine is not set up for " +
          "this installation",
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
    this.#skills.set(agentId, await this.#readSkills(agentId));
    this.#skillRetries.delete(agentId);
  }

  /**
   * Read one agent's catalog when this server has not read it yet.
   *
   * Separate from {@link refreshSkills}, which reads unconditionally: a
   * conversation that opens wants skills the agent wrote since the last read,
   * while a run that is already under way only needs an empty cache to stop
   * being empty. That distinction is what lets a run wait for this without
   * paying for a `podman exec` on every turn.
   *
   * A sleeping machine is not woken for this: opening a conversation must
   * not start a container (see `isRunning`), and the first prompt reads the
   * catalog after it wakes the machine (`ensureStellaSkills`).
   *
   * The failure case is deliberately soft. A read that throws leaves the
   * catalog as it was and stops being retried for SKILL_READ_RETRY_MS: a
   * conversation whose machine is restarting should run without skills, not
   * fail to run.
   */
  async ensureSkills(agentId: string): Promise<void> {
    if ((this.#skills.get(agentId)?.length ?? 0) > 0) return;
    if (this.#host === undefined) return;
    if (this.#running.get(agentId) !== true) return;
    const pending = this.#skillReads.get(agentId);
    if (pending !== undefined) {
      await pending;
      return;
    }
    const retryAt = this.#skillRetries.get(agentId);
    if (retryAt !== undefined && Date.now() < retryAt) return;
    const read = this.refreshSkills(agentId)
      .catch(() => {
        this.#skillRetries.set(agentId, Date.now() + SKILL_READ_RETRY_MS);
      })
      .finally(() => {
        this.#skillReads.delete(agentId);
      });
    this.#skillReads.set(agentId, read);
    await read;
  }

  /** One agent's catalog as last read (the factory builds tools
   * synchronously). Empty until the agent's first read, and a cold cache on a
   * running machine starts one: a run that found nothing here would tell its
   * agent that no skills exist, and nothing would read them again until the
   * conversation was reopened (a routine run after a server restart did
   * exactly that). */
  skills(agentId: string): SkillDef[] {
    const known = this.#skills.get(agentId);
    if (known !== undefined && known.length > 0) return known;
    if (this.#running.get(agentId) === true) void this.ensureSkills(agentId);
    return known ?? [];
  }

  /** Wake one agent's machine without waiting for a tool call (the pane's
   * "wake" button). */
  async wake(agentId: string): Promise<void> {
    await this.ensureReady(agentId);
  }

  // --- internals ---------------------------------------------------------

  #startReaper(): void {
    if (!this.#timer) return;
    const timer = setInterval(() => {
      void this.reapIdle().catch(() => {
        // The reaper is housekeeping: a failed pass leaves the machines as
        // they were and the next pass tries again.
      });
    }, this.#reapIntervalMs);
    timer.unref?.();
    this.#reaper = timer;
  }

  #stopReaper(): void {
    if (this.#reaper === undefined) return;
    clearInterval(this.#reaper);
    this.#reaper = undefined;
  }

  #enter(agentId: string): void {
    this.#active.set(agentId, (this.#active.get(agentId) ?? 0) + 1);
  }

  #leave(agentId: string): void {
    const left = (this.#active.get(agentId) ?? 0) - 1;
    if (left <= 0) this.#active.delete(agentId);
    else this.#active.set(agentId, left);
  }

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

  async #ensureAwake(agentId: string): Promise<void> {
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
      const host = this.require();
      await host.machine(agentId).start();
      this.#running.set(agentId, true);
      this.#desktops.delete(agentId);
      this.#desktopStarts.delete(agentId);
      this.touch(agentId);
    }).finally(() => {
      this.#starting.delete(agentId);
    });
    this.#starting.set(agentId, start);
    await start;
  }

  async #sleep(agentId: string): Promise<void> {
    if (this.#starting.has(agentId)) return;
    if (this.#active.get(agentId) !== undefined) return;
    if (this.#busy?.(agentId) === true) return;
    if ((this.#watchers.get(agentId) ?? 0) > 0) return;
    const stop = this.#enqueue(agentId, async () => {
      if (this.#starting.has(agentId)) return;
      if (this.#active.get(agentId) !== undefined) return;
      if (this.#busy?.(agentId) === true) return;
      if ((this.#watchers.get(agentId) ?? 0) > 0) return;
      const host = this.require();
      this.#running.set(agentId, false);
      this.#desktops.delete(agentId);
      this.#desktopStarts.delete(agentId);
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

  async #ensureDesktop(agentId: string): Promise<void> {
    if (this.#desktops.has(agentId)) return;
    const pending = this.#desktopStarts.get(agentId);
    if (pending !== undefined) {
      await pending;
      return;
    }
    const start = this.require()
      .machine(agentId)
      .startDesktop()
      .then(() => {
        this.#desktops.add(agentId);
      })
      .finally(() => {
        this.#desktopStarts.delete(agentId);
      });
    this.#desktopStarts.set(agentId, start);
    await start;
  }

  #forget(agentId: string): void {
    this.#running.delete(agentId);
    this.#lastUse.delete(agentId);
    this.#active.delete(agentId);
    this.#watchers.delete(agentId);
    this.#starting.delete(agentId);
    this.#stopping.delete(agentId);
    this.#queues.delete(agentId);
    this.#desktops.delete(agentId);
    this.#desktopStarts.delete(agentId);
    this.#skills.delete(agentId);
    this.#skillReads.delete(agentId);
    this.#skillRetries.delete(agentId);
  }

  #seams(agentId: string):
    | {
        exec: VmExec;
        execBytes: VmExecBytes;
        channel: VmChannelOpener;
      }
    | undefined {
    const host = this.#host;
    if (host === undefined) return undefined;
    const containerName = vmContainerName(agentId);
    return {
      exec: createVmExec({ run: this.run?.run ?? runVmCommand, containerName }),
      execBytes: createVmExecBytes({
        runBytes: this.run?.runBytes ?? runVmCommandBytes,
        containerName,
      }),
      channel: createVmChannel({
        open: this.run?.openChannel ?? openVmChannel,
        containerName,
      }),
    };
  }

  #execSeam(agentId: string): VmExec | undefined {
    return this.#host === undefined ? undefined : this.#seams(agentId)!.exec;
  }

  #execBytesSeam(agentId: string): VmExecBytes | undefined {
    return this.#host === undefined
      ? undefined
      : this.#seams(agentId)!.execBytes;
  }

  #readSkills(agentId: string): Promise<SkillDef[]> {
    const exec = this.#execSeam(agentId);
    if (exec === undefined) return Promise.resolve([]);
    return discoverVmSkills({
      exec,
      agentId,
      builtinSkills: builtinSkills({
        // The machine has its own browser and no host computer surface.
        browser: false,
        computer: false,
        // This is a stella session's catalog: its agent owns an identity and
        // may create more agents, and both tools are discoverable.
        stella: true,
        // A conversation can hand coding work to sub-agents (they run in
        // the same machine through the same exec seam).
        subagents: true,
        // The app-level MCP config is shared by every mode, and a stella
        // session's main agent changes it like any other (the tools live in
        // its main registry).
        mcpAdmin: true,
        // The machine has file tools, so the agent can write skills: its own
        // in its working folder, shared ones in the home's shared folder.
        skillAuthoring: { sharedDir: VM_SKILLS_DIR },
      }),
      ...(this.globalSkillDirs !== undefined
        ? { globalDirs: this.globalSkillDirs }
        : {}),
    });
  }
}
