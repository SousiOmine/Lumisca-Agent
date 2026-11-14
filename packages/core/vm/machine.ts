import { CoreError } from "../errors.ts";
import type { StellaStatus } from "../shared/wire.ts";
import { builtinSkills } from "../skills/builtin/mod.ts";
import type { SkillDef } from "../skills/discover.ts";
import { ensureAgentMemory } from "./agent-memory.ts";
import type { StellaAvailability } from "./availability.ts";
import { stellaAvailability } from "./availability.ts";
import type { VmCommandBytesRunner, VmCommandRunner } from "./command.ts";
import { runVmCommand, runVmCommandBytes } from "./command.ts";
import type {
  VmExec,
  VmExecBytes,
  VmManager,
  VmProgress,
} from "./container.ts";
import { createVmExec, createVmExecBytes } from "./container.ts";
import {
  VM_DESKTOP_SLOTS,
  VM_DESKTOP_WAIT_MS,
  VM_SKILLS_DIR,
  vmBusAddressOf,
  vmDisplayOf,
} from "./contract.ts";
import { discoverVmSkills } from "./skills.ts";

/** The pause between attempts at a slot nobody will give up yet. The wait is
 * rare (every desktop must belong to a conversation that is still working)
 * and each attempt is a handful of session lookups, so a quarter second is
 * cheap and short enough that a freed slot is not visibly idle. */
const DESKTOP_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Everything the stella machine holds between calls: the manager, the exec
 * seams built over it, the cached availability verdict and the skill catalog.
 * Kept out of LumiscaCore because none of it depends on sessions — the core
 * only asks this for a runtime when it opens a stella session. */
export class StellaMachine {
  #vm: VmManager | undefined;
  /** The availability verdict, cached until the next status read. */
  #verdict: StellaAvailability | undefined;
  /** The exec seams of the attached machine, rebuilt whenever the machine is
   * replaced (never carried across a detach, so a removed machine cannot be
   * reached through a stale reference). */
  #seams: { vm: VmManager; exec: VmExec; execBytes: VmExecBytes } | undefined;
  /** The skill catalogs, one per stella agent (keyed by agent id), refreshed
   * before each open. A catalog is per agent because an agent's own skills
   * live in its folder: only the machine-wide folder is shared. */
  #skills = new Map<string, SkillDef[]>();
  /** The in-flight start, shared by callers that race on a cold machine. */
  #starting: Promise<void> | undefined;
  /** Which desktop slot each agent owns, and the start in flight for it. */
  #desktops = new Map<string, { slot: number; started: Promise<void> }>();
  /** When each slot was last used, for choosing one to evict. */
  #slotUse = new Map<number, number>();
  /** Whether an agent's conversation is working right now, supplied by the
   * service that owns the sessions (the machine cannot see them). A slot
   * whose conversation is working is never taken from it. */
  #busy: ((agentId: string) => boolean) | undefined;
  /** How long `desktopFor` waits for a slot (VM_DESKTOP_WAIT_MS). */
  #desktopWaitMs: number;

  constructor(
    private readonly globalSkillDirs: string[] | undefined,
    private readonly run?:
      | { run: VmCommandRunner; runBytes: VmCommandBytesRunner }
      | undefined,
    /** Test seam: shorten the wait so a test can reach its end. */
    options: { desktopWaitMs?: number } = {},
  ) {
    this.#desktopWaitMs = options.desktopWaitMs ?? VM_DESKTOP_WAIT_MS;
  }

  /** Supply the answer to "is this agent's conversation working?", which the
   * machine needs before it takes a desktop away from its agent. Called once
   * by the service that owns the sessions. */
  setBusyCheck(check: (agentId: string) => boolean): void {
    this.#busy = check;
  }

  /** Attach (or detach, with undefined) the machine. */
  set(vm: VmManager | undefined): void {
    this.#vm = vm;
    // A new machine invalidates both the cached verdict (an image may have
    // been built since, or podman removed) and the exec seams.
    this.#verdict = undefined;
    this.#seams = undefined;
    this.#skills.clear();
    // The slots belonged to the machine that just went away: a different
    // container has no desktop running.
    this.#desktops.clear();
    this.#slotUse.clear();
  }

  get(): VmManager | undefined {
    return this.#vm;
  }

  /** Whether stella mode can run here, with the reason when it cannot. Read
   * from the machine's actual state, so installing podman or building the
   * image takes effect without a restart. */
  async availability(): Promise<StellaAvailability> {
    const vm = this.#vm;
    const verdict =
      vm === undefined
        ? {
            available: false as const,
            reason:
              "stella mode is not available: the virtual machine is not set up " +
              "for this installation",
          }
        : stellaAvailability(await vm.status());
    this.#verdict = verdict;
    return verdict;
  }

  /** The verdict recorded by the last availability read. */
  get verdict(): StellaAvailability | undefined {
    return this.#verdict;
  }

  /**
   * Make sure the machine is up, starting it (and building its image on a
   * first run) when it is not.
   *
   * Idempotent and safe to call concurrently: two prompts racing on a cold
   * machine share one start (the promise is memoized until it settles).
   */
  async ensureReady(
    onProgress?: (progress: VmProgress) => void,
  ): Promise<void> {
    const vm = this.require();
    // One read answers both questions. The availability check and the
    // running check used to be two `vm.status` calls, and the second one
    // (`fresh`) is never cached — on a host where the server is reached over
    // a phone, every redundant `podman` call is a second the user waits
    // before the conversation appears.
    const status = await vm.status({ fresh: true });
    const availability = stellaAvailability(status);
    if (!availability.available) {
      throw new Error(availability.reason);
    }
    if (this.#starting !== undefined) {
      await this.#starting;
      return;
    }
    if (status.state === "running") {
      this.#verdict = { available: true };
      return;
    }
    const starting = (async () => {
      this.#verdict = undefined;
      try {
        await vm.start();
        // The machine was down: every desktop that was running died with it,
        // and the slot each agent held no longer names a display.
        this.#desktops.clear();
        this.#slotUse.clear();
        void onProgress;
      } finally {
        this.#starting = undefined;
        this.#verdict = undefined;
      }
    })();
    this.#starting = starting;
    await starting;
  }

  /** Whether a start is in flight (the status endpoint reports it so a
   * waiting client can say "starting" instead of showing a stale state). */
  get starting(): boolean {
    return this.#starting !== undefined;
  }

  /** Whether the machine is up, as the status read the client already polls
   * saw it: no `fresh` bypass, so a read made within the cache window is
   * free.
   *
   * This is the cheap question opening an already-open conversation asks —
   * "is the machine still there?" — not the expensive one (`ensureReady`,
   * which decides whether it must be built or started). A container stopped
   * by hand is therefore noticed and brought back up, without every
   * selection paying for a fresh round of `podman` calls. */
  async isRunning(): Promise<boolean> {
    const vm = this.#vm;
    if (vm === undefined) return false;
    return (await vm.status()).state === "running";
  }

  /** The machine's state, as the status endpoint reports it. */
  async status(): Promise<StellaStatus> {
    const vm = this.#vm;
    if (vm === undefined) {
      const availability = await this.availability();
      return {
        availability,
        state: "unavailable",
        vncPort: null,
        reason: availability.available ? "" : availability.reason,
        starting: false,
      };
    }
    const status = await vm.status({ fresh: true });
    const availability = stellaAvailability(status);
    this.#verdict = availability;
    return {
      availability,
      state: status.state,
      vncPort: status.vncPort,
      reason: status.reason,
      starting: this.starting,
    };
  }

  /** Stop the machine (`podman stop`). Called on shutdown only. */
  async stop(): Promise<void> {
    await this.#vm?.stop();
    this.#verdict = undefined;
    // The container and everything in it is gone, desktops included.
    this.#desktops.clear();
    this.#slotUse.clear();
  }

  /**
   * The slot an agent's desktop runs on, starting it if this is the agent's
   * first use. Idempotent: concurrent callers share one start.
   *
   * A slot is the agent's for as long as its desktop runs. When all
   * VM_DESKTOP_SLOTS are taken, a desktop whose conversation is NOT working
   * gives way (the one nobody has touched for longest): its browser and
   * bridge stop, and its agent's next call starts a new desktop (the profile
   * keeps the logins). A conversation that is still working keeps its screen;
   * the caller waits for a slot to become free instead, up to
   * VM_DESKTOP_WAIT_MS.
   */
  async desktopFor(agentId: string): Promise<number> {
    const vm = this.require();
    const known = this.#desktops.get(agentId);
    if (known !== undefined) {
      this.#slotUse.set(known.slot, Date.now());
      await known.started;
      return known.slot;
    }
    // The claim and the entry that records it are one synchronous stretch,
    // before anything is awaited: two conversations that start at the same
    // moment would otherwise both read the same free slot and one of them
    // would end up in the other's browser.
    const deadline = Date.now() + this.#desktopWaitMs;
    let claim = this.#claimSlot();
    while (claim === null) {
      if (Date.now() >= deadline) {
        throw new CoreError(
          `All ${VM_DESKTOP_SLOTS} desktops are in use by conversations that ` +
            "are still working. Try again when one of them has finished.",
          "conflict",
        );
      }
      await sleep(DESKTOP_POLL_MS);
      claim = this.#claimSlot();
    }
    const { slot, evicted } = claim;
    const started = (async () => {
      if (evicted) await vm.stopDesktop(slot);
      await vm.startDesktop(slot, agentId);
    })();
    this.#desktops.set(agentId, { slot, started });
    this.#slotUse.set(slot, Date.now());
    try {
      await started;
    } catch (failure) {
      // A failed start must not leave the slot looking taken.
      this.#desktops.delete(agentId);
      this.#slotUse.delete(slot);
      throw failure;
    }
    return slot;
  }

  /** The host port of an agent's screen, starting its desktop when the
   * reader gets there before the agent does. */
  async vncPortFor(agentId: string): Promise<number | null> {
    const vm = this.#vm;
    if (vm === undefined) return null;
    const slot = await this.desktopFor(agentId);
    return await vm.vncPort(slot);
  }

  /** A free slot, or the one held by an idle conversation (the least recently
   * used one), claimed for the caller. Synchronous on purpose (see
   * `desktopFor`): by the time it returns, no other caller may see the slot
   * as free. Null when every slot belongs to a conversation that is still
   * working. */
  #claimSlot(): { slot: number; evicted: boolean } | null {
    const taken = new Map<number, string>();
    for (const [agent, desktop] of this.#desktops) {
      taken.set(desktop.slot, agent);
    }
    for (let slot = 0; slot < VM_DESKTOP_SLOTS; slot++) {
      if (!taken.has(slot)) return { slot, evicted: false };
    }
    let candidate: { slot: number; agent: string } | undefined;
    for (const [slot, agent] of taken) {
      if (this.#isBusy(agent)) continue;
      if (
        candidate === undefined ||
        (this.#slotUse.get(slot) ?? 0) <
          (this.#slotUse.get(candidate.slot) ?? 0)
      ) {
        candidate = { slot, agent };
      }
    }
    if (candidate === undefined) return null;
    this.#desktops.delete(candidate.agent);
    this.#slotUse.delete(candidate.slot);
    return { slot: candidate.slot, evicted: true };
  }

  /** Whether an agent's conversation is working. The check is required: a
   * machine that guessed "nobody is working" would take a screen from under
   * a run. */
  #isBusy(agentId: string): boolean {
    const check = this.#busy;
    if (check === undefined) {
      throw new Error(
        "The stella machine cannot tell whether a conversation is working: " +
          "setBusyCheck was not called",
      );
    }
    return check(agentId);
  }

  /**
   * One agent's exec seam: every call carries that desktop's `DISPLAY` and
   * session bus, and starts the desktop first when the agent has not used its
   * screen yet.
   *
   * The screen tools, the semantic tools, `vm_launch` and the clipboard take
   * this seam, so they all land on the same desktop and on its own
   * accessibility tree. Files, the shell and a background command keep the
   * machine's seam: starting a browser under `ls` would be a desktop for
   * nothing. A GUI program is therefore started with `vm_launch`; one started
   * from `bash` opens on the machine's own display, which no conversation
   * shows.
   */
  execFor(agentId: string): VmExec | undefined {
    const base = this.exec();
    if (base === undefined) return undefined;
    return async (command, exec) => {
      const slot = await this.desktopFor(agentId);
      return base(command, {
        ...exec,
        env: {
          ...exec.env,
          DISPLAY: vmDisplayOf(slot),
          DBUS_SESSION_BUS_ADDRESS: vmBusAddressOf(slot),
        },
      });
    };
  }

  /** The byte variant of {@link execFor} (a screen capture). */
  execBytesFor(agentId: string): VmExecBytes | undefined {
    const base = this.execBytes();
    if (base === undefined) return undefined;
    return async (command, exec) => {
      const slot = await this.desktopFor(agentId);
      return base(command, {
        ...exec,
        env: {
          ...exec.env,
          DISPLAY: vmDisplayOf(slot),
          DBUS_SESSION_BUS_ADDRESS: vmBusAddressOf(slot),
        },
      });
    };
  }

  /** The exec seam of the attached machine, or undefined without one. */
  exec(): VmExec | undefined {
    return this.#seamCache()?.exec;
  }

  execBytes(): VmExecBytes | undefined {
    return this.#seamCache()?.execBytes;
  }

  #seamCache(): { exec: VmExec; execBytes: VmExecBytes } | undefined {
    const vm = this.#vm;
    if (vm === undefined) return undefined;
    if (this.#seams?.vm !== vm) {
      this.#seams = {
        vm,
        exec: createVmExec({ run: this.run?.run ?? runVmCommand }),
        execBytes: createVmExecBytes({
          runBytes: this.run?.runBytes ?? runVmCommandBytes,
        }),
      };
    }
    return this.#seams;
  }

  /** The machine, or an error saying there is none. */
  require(): VmManager {
    if (this.#vm === undefined) {
      throw new Error(
        "stella mode is not available: the virtual machine is not set up for " +
          "this installation",
      );
    }
    return this.#vm;
  }

  /** Create the agent's working folder inside the machine and leave an empty
   * MEMORY.md in it (idempotent: an existing file is never emptied). */
  async ensureAgentFolder(agentId: string): Promise<void> {
    const exec = this.exec();
    if (exec === undefined) return;
    await ensureAgentMemory(exec, agentId);
  }

  /** Re-read one agent's skill catalog: the agent's own skills, the
   * machine's shared folder, and the user's global and built-in set.
   * Awaited before a stella session opens. */
  async refreshSkills(agentId: string): Promise<void> {
    this.#skills.set(agentId, await this.#readSkills(agentId));
  }

  /** One agent's catalog as last read (the factory builds tools
   * synchronously). Empty until the agent's first refresh. */
  skills(agentId: string): SkillDef[] {
    return this.#skills.get(agentId) ?? [];
  }

  #readSkills(agentId: string): Promise<SkillDef[]> {
    const exec = this.exec();
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
        // in its working folder, shared ones in the machine-wide folder.
        skillAuthoring: { sharedDir: VM_SKILLS_DIR },
      }),
      ...(this.globalSkillDirs !== undefined
        ? { globalDirs: this.globalSkillDirs }
        : {}),
    });
  }
}
