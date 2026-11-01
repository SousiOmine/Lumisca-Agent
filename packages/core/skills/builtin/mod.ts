import type { SkillDef } from "../discover.ts";
import { webBrowserSkill } from "./web-browser.ts";
import { computerUseSkill } from "./computer-use.ts";
import { agentCreateSkill } from "./agent-create.ts";
import { codingAgentsSkill } from "./coding-agents.ts";
import { identitySkill } from "./identity.ts";

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
}

/** The app-embedded skill set for a session context. */
export function builtinSkills(context: BuiltinContext): SkillDef[] {
  return [
    ...(context.browser ? [webBrowserSkill()] : []),
    ...(context.computer ? [computerUseSkill()] : []),
    ...(context.stella === true ? [agentCreateSkill(), identitySkill()] : []),
    ...(context.subagents ? [codingAgentsSkill()] : []),
  ];
}
