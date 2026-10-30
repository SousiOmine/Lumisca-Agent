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
import type { HandoverHub } from "./handover.ts";
import type { ContextProvider } from "../agent/context-providers.ts";

export interface StellaRuntime {
  /** The session's working folder inside the machine: where relative paths
   * resolve and where bash starts. One folder per agent, so two agents do
   * not share their `src/`. */
  cwd: string;
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
  /** The screen tools (`vm_screenshot` / `vm_act` / `vm_ask_user`),
   * preloaded. */
  screenTools: Tool[];
  /** `chat_ui`: show a card (text, table, flow, a question with choices) in
   * the chat. */
  chatUiTool: Tool;
  /** The routine tools (`routine_create` / `list` / `update` / `delete` /
   * `run`), bound to this session's agent. Discoverable through
   * tool_search, not preloaded. */
  routineTools: Tool[];
  /** The session's screen hand-over: the tool blocks inside it while the
   * user drives the machine, and the agent tears it down with the run. */
  handoverHub: HandoverHub;
  /** `agent_create`, which adds another agent to the sidebar. */
  agentTool: Tool;
  /** `history_search`, which reads this conversation's saved history back
   * (the turns a compaction checkpoint replaced are no longer in the
   * model's context, but every message is still a row). */
  historyTool: Tool;
  /** `identity`, which reads and rewrites the agent's own description of
   * itself (the persona the agent writes, separate from the role the user
   * gave it at creation). */
  identityTool: Tool;
  /** The identity's context provider: publishes what the agent wrote as a
   * durable transcript message, so a write reaches the next run without
   * touching the snapshotted system prompt (see stella/identity.ts). */
  identityProvider: ContextProvider;
}
