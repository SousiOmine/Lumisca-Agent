/**
 * Everything a stella session's tools need, resolved once per agent open.
 *
 * The factory asks the pool for this and either gets it (a stella session) or
 * does not (every other session, which uses the host). Bundling it keeps the
 * factory from growing four separate seams — backends, spawner, skills,
 * screen — that must all be supplied together for a stella session to work at
 * all.
 */
import type { BackgroundSpawner } from "../tools/background-backend.ts";
import type { CommandRunner } from "../tools/command-backend.ts";
import type { FileBackend } from "../tools/file-backend.ts";
import type { Tool } from "../tools/schema.ts";
import type { SkillDef } from "../skills/discover.ts";

export interface StellaRuntime {
  files: FileBackend;
  runner: CommandRunner;
  backgroundSpawner: BackgroundSpawner;
  /** The session's skill catalog: the machine's `.agents/skills` plus the
   * user's host-global and built-in skills. Read synchronously because the
   * agent factory builds tools synchronously (a rebuild happens mid-change);
   * `refreshSkills` re-reads it, and every caller that opens a session awaits
   * that first. A catalog a few seconds stale is harmless — it is a list of
   * names and descriptions. */
  skills(): SkillDef[];
  /** Re-read the catalog from the machine (awaited before a session opens). */
  refreshSkills(): Promise<void>;
  /** The screen tools (`vm_screenshot` / `vm_act`), preloaded. */
  screenTools: Tool[];
  /** `agent_create`, which adds another counterpart to the sidebar. */
  agentTool: Tool;
  /** `history_search`, which reads this conversation's saved history back
   * (the turns a compaction checkpoint replaced are no longer in the
   * model's context, but every message is still a row). */
  historyTool: Tool;
}
