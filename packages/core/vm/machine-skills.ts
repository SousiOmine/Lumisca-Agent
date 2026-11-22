/**
 * One agent's skill catalog inside the machine, and the reads that fill it.
 *
 * A catalog is per agent because an agent's own skills live in its folder:
 * only the machine-wide folder is shared (see vm/skills.ts).
 *
 * Two reads exist and they differ in when they happen, not in what they do:
 * opening a conversation re-reads unconditionally (`refresh`), so a skill the
 * agent wrote during the conversation is there next time; a run that is
 * already under way only needs an empty cache to stop being empty (`ensure`),
 * which is what lets it wait without paying for a `podman exec` on every turn.
 *
 * A read never wakes a sleeping machine. Opening a conversation must not start
 * a container, and the first prompt reads the catalog after it wakes the
 * machine.
 */

import { builtinSkills } from "../skills/builtin/mod.ts";
import type { SkillDef } from "../skills/discover.ts";
import type { VmExec } from "./container.ts";
import { VM_SKILLS_DIR } from "./contract.ts";
import { discoverVmSkills } from "./skills.ts";

/** How long a failed read waits before it is asked again.
 *
 * A read is started from inside a run when the catalog is cold, so a machine
 * that is not answering would otherwise be asked once per run and once per
 * `skill` call. A container restart is what makes a read fail, and it takes
 * seconds: this is long enough that a broken machine is not hammered and short
 * enough that the turn after a restart finds the skills. */
const SKILL_READ_RETRY_MS = 30_000;

export class AgentSkills {
  /** The catalogs, one per agent, as last read. */
  #catalogs = new Map<string, SkillDef[]>();
  /** The reads in flight, one per agent: `skills` is called by every run and
   * by the skill tool, and a cold cache must start one read rather than one
   * per call. */
  #reads = new Map<string, Promise<void>>();
  /** When each agent's last read failed (see SKILL_READ_RETRY_MS). */
  #retries = new Map<string, number>();

  constructor(
    private readonly options: {
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

  /** Drop every catalog (a different host has different files). */
  clear(): void {
    this.#catalogs.clear();
    this.#reads.clear();
    this.#retries.clear();
  }

  /** Drop one agent's catalog (its machine was removed). */
  forget(agentId: string): void {
    this.#catalogs.delete(agentId);
    this.#reads.delete(agentId);
    this.#retries.delete(agentId);
  }

  /** Re-read one agent's catalog: the agent's own skills, the machine-wide
   * folder, and the user's global and built-in set. */
  async refresh(agentId: string): Promise<void> {
    this.#catalogs.set(agentId, await this.#read(agentId));
    this.#retries.delete(agentId);
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
    if ((this.#catalogs.get(agentId)?.length ?? 0) > 0) return;
    if (!this.options.hasHost()) return;
    if (!this.options.isRunning(agentId)) return;
    const pending = this.#reads.get(agentId);
    if (pending !== undefined) {
      await pending;
      return;
    }
    const retryAt = this.#retries.get(agentId);
    if (retryAt !== undefined && Date.now() < retryAt) return;
    const read = this.refresh(agentId)
      .catch(() => {
        this.#retries.set(agentId, Date.now() + SKILL_READ_RETRY_MS);
      })
      .finally(() => {
        this.#reads.delete(agentId);
      });
    this.#reads.set(agentId, read);
    await read;
  }

  /** One agent's catalog as last read (the factory builds tools
   * synchronously). Empty until the agent's first read, and a cold cache on a
   * running machine starts one: a run that found nothing here would tell its
   * agent that no skills exist, and nothing would read them again until the
   * conversation was reopened (a routine run after a server restart did
   * exactly that). */
  skills(agentId: string): SkillDef[] {
    const known = this.#catalogs.get(agentId);
    if (known !== undefined && known.length > 0) return known;
    if (this.options.isRunning(agentId)) void this.ensure(agentId);
    return known ?? [];
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
