import type { SkillDef } from "../discover.ts";
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
 * session's tool registry only when a browser backend is present). Such
 * skills are gated through `context`, so a session that can never run
 * them does not advertise them — an agent must not be pointed at a dead
 * end.
 */

/** Runtime capabilities a session may or may not have. */
export interface BuiltinContext {
  /** Whether a browser backend is attached to the session (Desktop WebView
   * host, CLI browser host, or a server started by the desktop shell).
   * The web-browser skill is included only when true. */
  browser: boolean;
}

/** The app-embedded skill set for a session context. */
export function builtinSkills(context: BuiltinContext): SkillDef[] {
  return [
    ...(context.browser ? [webBrowserSkill()] : []),
  ];
}
