import type { SkillDef } from "../discover.ts";
import { agentCreateSkill } from "./agent-create.ts";
import { codingAgentsSkill } from "./coding-agents.ts";
import { computerUseSkill } from "./computer-use.ts";
import { desktopAppsSkill } from "./desktop-apps.ts";
import { folderShareSkill } from "./folder-share.ts";
import { identitySkill } from "./identity.ts";
import { mcpServersSkill } from "./mcp-servers.ts";
import { routinesSkill } from "./routines.ts";
import { skillAuthoringSkill } from "./skill-authoring.ts";
import { vmEnvSkill } from "./vm-env.ts";
import { webBrowserSkill } from "./web-browser.ts";

/**
 * App-embedded skills: shipped with the application itself, always
 * available without installing anything — unlike file-based skills
 * (workspace `.agents/skills`, agent plugins, `~/.agents/skills`). They
 * enter a session's skill set at the lowest precedence (see
 * DiscoverOptions.builtinSkills), so a user skill of the same name
 * overrides them.
 *
 * A built-in skill may teach tools that only exist when a runtime
 * capability is attached (the browser-lab tools are seeded into the
 * session's tool registry only when a browser backend is present, and the
 * computer-use tools only when this machine can be driven AND the user
 * enabled the feature). Such skills are gated through `context`, so a
 * session that can never run them does not advertise them — an agent must
 * not be pointed at a dead end.
 */

/** Runtime capabilities a session may or may not have. */
export interface BuiltinContext {
  /** Whether a browser backend is attached to the session (the Desktop
   * WebView host of a server started by the desktop shell). The
   * web-browser skill is included only when true. */
  browser: boolean;
  /** Whether the session may drive this machine (a computer host is
   * attached AND the user enabled the feature in settings). The
   * computer-use skill is included only when true. */
  computer: boolean;
  /** Whether the session is a stella conversation. Its agent owns a
   * sidebar identity and may create more agents, and both tools are
   * discoverable rather than preloaded; the agent-create and identity
   * skills teach them. Absent → neither skill is advertised (a code-mode
   * session has no agents to manage). */
  stella?: boolean;
  /** Whether the session can start coding sub-agents (it has a tool hub).
   * The coding-agents skill is included only when true: it teaches the
   * `task` tool, and a session that cannot start one must not be pointed at
   * it. */
  subagents: boolean;
  /** Whether this session's main agent may change the app-level MCP server
   * config (`mcp_add` / `mcp_remove` / `mcp_list`). The mcp-servers skill is
   * included only when true: those tools are main-only — the config
   * outlives a sub-agent's run — so a sub-agent must not be told to look
   * for them. Absent → not advertised. */
  mcpAdmin?: boolean;
  /** Where this session may write skills. Present only when it has the file
   * tools to do it (a chat session does not): the skill-authoring guide is
   * otherwise a pointer at tools the session cannot run. `sharedDir` is the
   * folder every agent of this mode reads (the Lumisca skills folder on the
   * host, or the stella machine's own), so the guide can name it; absent
   * when the installation has no such folder. */
  skillAuthoring?: {
    sharedDir?: string;
  };
}

/** The app-embedded skill set for a session context. */
export function builtinSkills(context: BuiltinContext): SkillDef[] {
  return [
    ...(context.browser ? [webBrowserSkill()] : []),
    ...(context.computer ? [computerUseSkill()] : []),
    // The machine's GUI, always available in a stella session: the semantic
    // tools are preloaded there (agent/factory.ts), so the guide is what makes
    // them the default over reading coordinates off a picture.
    ...(context.stella === true ? [desktopAppsSkill()] : []),
    ...(context.stella === true ? [agentCreateSkill(), identitySkill()] : []),
    // The routines belong to an agent's conversation, and the tools that
    // create them are discoverable — this is the only thing that tells the
    // agent they exist at all (#39).
    ...(context.stella === true ? [routinesSkill()] : []),
    // `vm_env` is discoverable for the same reason, and its tool is
    // main-only: the variables belong to the machine, so code mode (no
    // machine) and sub-agents (no dialog they could show) are not pointed at
    // it.
    ...(context.stella === true ? [vmEnvSkill()] : []),
    // The same for the two tools that ask about a lent folder: they are
    // stella's and discoverable, so this guide is what tells the agent they
    // exist at all.
    ...(context.stella === true ? [folderShareSkill()] : []),
    ...(context.mcpAdmin === true ? [mcpServersSkill()] : []),
    // Skills are written with the file tools, so the guide follows them: no
    // file tools (a chat session) → nothing to teach about writing files.
    ...(context.skillAuthoring !== undefined
      ? [
          skillAuthoringSkill({
            ...(context.skillAuthoring.sharedDir !== undefined
              ? { sharedDir: context.skillAuthoring.sharedDir }
              : {}),
            stella: context.stella === true,
          }),
        ]
      : []),
    ...(context.subagents ? [codingAgentsSkill()] : []),
  ];
}
