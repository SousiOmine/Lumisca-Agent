/**
 * One agent's skill catalog inside the machine, and the reads that fill it.
 *
 * A catalog is per agent because an agent's own skills live in its folder:
 * only the machine-wide folder is shared (see vm/skills.ts).
 *
 * Two reads exist and they differ in when they happen, not in what they do:
 * `refresh` re-reads unconditionally, for the calls that know something
 * changed; `ensure` makes the catalog current enough to use, reusing a read
 * that is still within SKILLS_REUSE_MS so a run does not pay for a
 * `podman exec` on every turn. They are the whole public surface: every
 * caller wants one of those two.
 *
 * A read never wakes a sleeping machine. Opening a conversation must not start
 * a container, and the first prompt reads the catalog after it wakes the
 * machine.
 *
 * The catalog and its timing live in the agent's one state record (see
 * machine-state.ts): `skills`, `skillsRead` and `skillsRetryAt`.
 */

import { builtinSkills } from "../skills/builtin/mod.ts";
import type { SkillDef } from "../skills/discover.ts";
import type { VmExec } from "./container.ts";
import { VM_SKILLS_DIR } from "./contract.ts";
import type { MachineStates } from "./machine-state.ts";
import { discoverVmSkills } from "./skills.ts";

/** How long a catalog read stays usable for. A read crosses into the machine
 * (`podman exec`), and a conversation opened from a phone over a slow link
 * must not wait for a list that has not changed. A skill the agent wrote
 * during a conversation is picked up by the next read after the window. */
export const SKILLS_REUSE_MS = 30_000;

/** How long a failed read waits before it is asked again.
 *
 * A read is started from inside a run when the catalog is cold, so a machine
 * that is not answering would otherwise be asked once per run and once per
 * `skill` call. A container restart is what makes a read fail, and it takes
 * seconds: this is long enough that a broken machine is not hammered and short
 * enough that the turn after a restart finds the skills. */
const SKILL_READ_RETRY_MS = 30_000;

export class AgentSkills {
  constructor(
    private readonly options: {
      /** The per-agent state, created and dropped in one place. */
      states: MachineStates;
      /** The user's global skill folders, as the app was started with. */
      globalSkillDirs: string[] | undefined;
      /** Whether a host is attached at all (code mode has none). */
      hasHost: () => boolean;
      /** Whether the agent's machine is known to be up. */
      isRunning: (agentId: string) => boolean;
      /** One agent's exec seam, without waking the machine. */
      exec: (agentId: string) => VmExec | undefined;
    },
  ) {}

  /** Re-read one agent's catalog: the agent's own skills, the machine-wide
   * folder, and the user's global and built-in set. */
  async refresh(agentId: string): Promise<void> {
    const state = this.options.states.of(agentId);
    state.skills = { defs: await this.#read(agentId), readAt: Date.now() };
    state.skillsRetryAt = undefined;
  }

  /**
   * Read one agent's catalog when this server has not read it yet.
   *
   * The failure case is deliberately soft. A read that throws leaves the
   * catalog as it was and stops being retried for SKILL_READ_RETRY_MS: a
   * conversation whose machine is restarting should run without skills, not
   * fail to run.
   */
  async ensure(agentId: string): Promise<void> {
    const state = this.options.states.of(agentId);
    if (!this.options.hasHost()) return;
    if (!this.options.isRunning(agentId)) return;
    const pending = state.skillsRead;
    if (pending !== undefined) {
      await pending;
      return;
    }
    // A read that just happened — or one already in flight — is the same
    // catalog: asking again would be a `podman exec` for a list nothing can
    // have changed. The window is why opening a conversation is cheap and why
    // a routine run reuses what the last open read.
    const known = state.skills;
    if (
      known !== undefined &&
      known.defs.length > 0 &&
      Date.now() - known.readAt < SKILLS_REUSE_MS
    ) {
      return;
    }
    const retryAt = state.skillsRetryAt;
    if (retryAt !== undefined && Date.now() < retryAt) return;
    const read = this.refresh(agentId)
      .catch(() => {
        state.skillsRetryAt = Date.now() + SKILL_READ_RETRY_MS;
      })
      .finally(() => {
        state.skillsRead = undefined;
      });
    state.skillsRead = read;
    await read;
  }

  /** One agent's catalog as last read (the factory builds tools
   * synchronously). Empty until the agent's first read, and a cold cache on a
   * running machine starts one: a run that found nothing here would tell its
   * agent that no skills exist, and nothing would read them again until the
   * conversation was reopened (a routine run after a server restart did
   * exactly that). */
  skills(agentId: string): SkillDef[] {
    const defs = this.options.states.known(agentId)?.skills?.defs;
    if (defs !== undefined && defs.length > 0) return defs;
    if (this.options.isRunning(agentId)) void this.ensure(agentId);
    return defs ?? [];
  }

  /** Two folders, one exec each, so the read is one round trip per folder. */
  #read(agentId: string): Promise<SkillDef[]> {
    const exec = this.options.exec(agentId);
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
      ...(this.options.globalSkillDirs !== undefined
        ? { globalDirs: this.options.globalSkillDirs }
        : {}),
    });
  }
}
