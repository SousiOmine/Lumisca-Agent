/**
 * Where one session works, and what follows from it.
 *
 * The answer is one struct rather than a handful of getters each caller
 * re-invokes: a session's place (its machine, its workspace folders, the
 * folders lent to it) decides its backends, whether it is the folder-less chat
 * one, and which capability gates apply. The tool set, the discoverable
 * registry, the skill catalog and the sub-agents' runtime all read this same
 * answer, so they cannot disagree about where the session is.
 */

import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { CoreError } from "../errors.ts";
import type { McpAdmin } from "../mcp/manage-tools.ts";
import { mountedBackends } from "../share/mounted-backends.ts";
import { hostBackends, type ToolBackends } from "../tools/toolsets.ts";
import type { StellaRuntime } from "../vm/runtime.ts";
import type { SearchProvider } from "../websearch/types.ts";
import type { SessionPoolDeps } from "./deps.ts";

/** Where a session's tools run, plus the capability flags that follow from
 * it. Resolved once per open (see resolveSessionWhere) and threaded through
 * the phases, so no phase has to re-derive "is this stella?" or re-invoke a
 * capability getter. */
export interface SessionWhere {
  /** The stella runtime when this is a stella session; undefined otherwise. */
  stella: StellaRuntime | undefined;
  /** The file/command backend every tool of the session works through. */
  backends: ToolBackends;
  /** The session's workspace is the folder-less chat one. */
  chat: boolean;
  /** A chat session without a machine: no shell, no sub-agents, no files. */
  chatOnly: boolean;
  /** The browser lab is attached to this server (gates its tools and skill). */
  browserAvailable: boolean;
  /** Whether computer use is available AND enabled (gates its tools and
   * skill). A getter, not a value: the settings toggle reaches a running
   * session without rebuilding it (see SessionPool.applyCapabilityChange),
   * so a value captured at open would go stale exactly where it matters. */
  computerAvailable: () => boolean;
  /** Whether the model is given `execute` instead of its tool set (see
   * applyCodeExecution). A value, not a getter: the tool set is fixed for
   * the life of an agent, and the pool rebuilds the open sessions when the
   * toggle changes (see SessionPool.applyAgentBuildChange). */
  codeExecution: boolean;
  /** Whether the model is offered the ask tool. A value for the same
   * reason: the tool set is fixed for the life of an agent, and the pool
   * rebuilds the open sessions when the toggle changes. */
  askTool: boolean;
  /** The user's web-search provider, when one is configured. */
  webSearch: SearchProvider | undefined;
  /** The app-level MCP config this agent may change, or undefined when the
   * session has no administration tools (a pool built by hand without the
   * service). Gates both the tools and the guide that teaches them. */
  mcpAdmin: McpAdmin | undefined;
}

/**
 * Where this session's tools run, and the capability flags that follow from
 * it. Resolved once per open, so every tool of the agent — and every
 * sub-agent it spawns — works in the same place.
 */
export function resolveSessionWhere(
  deps: SessionPoolDeps,
  session: SessionInfo,
  workspace: Workspace,
): SessionWhere {
  // A stella session works inside its virtual machine; every other session
  // works in this machine's workspace.
  const stella =
    session.stella === true ? deps.stellaRuntime?.(session) : undefined;
  if (session.stella === true && stella === undefined) {
    // Only reachable if the machine was detached while its session stayed
    // open. Failing loudly beats building a stella agent with host tools —
    // it would silently gain access to the user's own filesystem.
    throw new CoreError(
      "The stella machine is not available for this session",
      "unavailable",
    );
  }
  // The session's own place, plus every folder lent to it from the user's
  // computer: the tools do not know which machine a path is on, so the two
  // are folded together here, once (see share/mounted-backends.ts).
  const backends: ToolBackends = mountedBackends(
    stella !== undefined
      ? { files: stella.files, runner: stella.runner }
      : hostBackends(workspace, { appSkillDirs: deps.appSkillDirs }),
    deps.shares?.(),
    session.id,
  );
  // A stella conversation row lives in the folder-less chat workspace (it
  // has no folders of its own — its files are in the machine), but it is
  // NOT a chat session: it has a shell, background commands and
  // sub-agents. The two flags are therefore read together everywhere the
  // chat set would otherwise suppress a surface.
  const chatOnly = workspace.chat && stella === undefined;
  // The browser-lab and computer-use tools follow one gate each: the
  // getter answers undefined when this machine cannot provide it (no
  // backend, no display, or the user has not enabled the feature). The
  // same value gates the built-in skills those tools come with.
  //
  // Computer use is code mode's: it drives THIS machine's screen, mouse and
  // keyboard, and a stella session works inside its own virtual machine —
  // the session gets the machine's screen tools (`vm_screenshot` /
  // `vm_act`), so a second, host-facing way to look at a screen would be a
  // way out of the machine as well as a duplicate of the one it has. The
  // gate is applied here, where "where this session works" is decided,
  // rather than in the tools, so the skill catalog and the capability flags
  // a sub-agent inherits agree with the tool set.
  const browser = deps.browser?.();
  return {
    stella,
    backends,
    chat: workspace.chat,
    chatOnly,
    browserAvailable: browser !== undefined,
    // Read per call rather than captured: the toggle is applied to a
    // running session in place, and the skill catalog re-reads this on
    // every turn (see seedDiscoverableTools for the tools themselves).
    computerAvailable: () =>
      stella === undefined && deps.computer?.() !== undefined,
    // Read once per open: the answer decides the whole tool set of this
    // agent, which cannot change under a run.
    codeExecution: deps.isCodeExecutionEnabled(),
    askTool: deps.isAskToolEnabled(),
    // The user's web-search provider. Resolved once per open (the tools
    // hold it, so a rebuild picks up a changed default) and undefined when
    // the user has not configured one; the tools are then simply absent.
    webSearch: deps.webSearch?.(),
    // The MCP administration surface. A core always has one; a pool built
    // by hand without it simply gets neither the tools nor the guide.
    mcpAdmin: deps.mcpAdmin?.(),
  };
}
