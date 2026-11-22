/**
 * The tool sets a sub-agent is spawned with, and the wiring that brings the
 * session's discoverable tools to the ones already running.
 *
 * Three things meet here and nowhere else:
 *
 * - the set a sub-agent starts with (`explore`'s read-only investigation
 *   tools, `general`'s coding set, both plus the session's skill tool),
 * - the tool_search / tool_call pair over the session's registry — the only
 *   way an MCP server, the browser lab or a future extension reaches a
 *   sub-agent, whose definitions never enter the LLM context,
 * - MCP discovery finishing after a sub-agent already started: the pair is
 *   appended to the running agents that spawned before the registry held
 *   anything.
 *
 * The hub owns when this happens (spawn, setMcp) and who it applies to; what
 * a set contains and how the pair is attached is this module's.
 */

import type { McpAttachment } from "../mcp/attachment.ts";
import { withOnDemandToolsNote } from "../mcp/context.ts";
import { addToolsToAgent, registryToolPair } from "../mcp/tools.ts";
import type { Tool } from "../ports/tool.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import type { SkillDef } from "../skills/discover.ts";
import { createSkillTool } from "../skills/tool.ts";
import type { SearchProvider } from "../websearch/types.ts";
import { createBashTool } from "./bash.ts";
import { createEvalTool } from "./eval.ts";
import type { ToolRegistry } from "./registry.ts";
import type { Subagent } from "./subagent-registry.ts";
import {
  fileTools,
  readOnlyInvestigationTools,
  type ToolBackends,
} from "./tool-pieces.ts";
import { createWebSearchTools } from "./web.ts";

/** Read-only investigation tools of the `explore` sub-agent. */
export function exploreTools(
  backends: ToolBackends,
  safety: CommandSafety | undefined,
  skills: () => SkillDef[],
): Tool[] {
  return [
    ...readOnlyInvestigationTools(backends.files, backends.runner, safety),
    createSkillTool({ skills }),
  ];
}

/** Full coding tool set of the `general` sub-agent: the session's tools
 * without ask/todo/async_bash. Sub-agents have no UI round trip (ask), no
 * plan panel of their own (todo), and no background commands that would
 * outlive them (async_bash). `safety` (when present) gates their bash/eval
 * tools like the main agent's; browser-lab tools are not preloaded either
 * — general sub-agents reach them through the session's tool registry via
 * the search/call pair, exactly like the main agent.
 *
 * `eval` is the session's call, not this function's: it runs JavaScript in
 * the SERVER process, so a session that works inside the stella machine
 * (whose whole premise is that nothing outside it is reachable) must not
 * hand it out — not even to a sub-agent. The runtime says which it is (see
 * SubagentRuntime.eval); there is no default, so a caller has to decide. */
export function generalTools(
  backends: ToolBackends,
  evalTool: boolean,
  safety: CommandSafety | undefined,
  webSearch: SearchProvider | undefined,
  skills: () => SkillDef[],
): Tool[] {
  return [
    ...fileTools(backends.files),
    createBashTool({
      files: backends.files,
      runner: backends.runner,
      safety,
    }),
    ...(evalTool ? [createEvalTool({ safety })] : []),
    ...(webSearch === undefined ? [] : createWebSearchTools(webSearch)),
    createSkillTool({ skills }),
  ];
}

/**
 * The session's tool registry as the sub-agents see it, and the pair built
 * over it.
 *
 * The registry is held by reference and resolved through a getter, so a
 * config change that swaps it (pool.open with a new MCP attachment)
 * redirects pairs already attached to running sub-agents without replacing
 * them.
 */
export class SubagentToolWiring {
  private registry: ToolRegistry | null = null;
  /** The attachment whose discovery has been (or will be) applied to the
   * registry and the running sub-agents. Guards against stale callbacks: a
   * config change replaces the attachment mid-discovery, and the old
   * attachment's ready must not overwrite the current registry or attach
   * its tools. */
  private handledAttachment: McpAttachment | null = null;

  constructor(
    private readonly options: {
      /** The agents a finished discovery may still reach: those spawned
       * before the registry held anything. */
      runningAgents: () => Iterable<Subagent>;
    },
  ) {}

  /** Attach the session's shared MCP attachment and tool registry. Only the
   * current attachment is registered for: an attachment replaced by a config
   * change must never apply its (stale or empty) tools. */
  set(attachment: McpAttachment | null, registry: ToolRegistry | null): void {
    this.registry = registry;
    if (attachment !== null && attachment !== this.handledAttachment) {
      this.handledAttachment = attachment;
      attachment.whenReady((tools) =>
        this.attachMcpToRunning(attachment, tools),
      );
    }
  }

  /** The tool_search / tool_call pair backed by the session's registry
   * (empty when the session has no discoverable tools). */
  searchTools(): Tool[] {
    if (this.registry === null || this.registry.isEmpty) return [];
    return registryToolPair(() => this.registry!);
  }

  /** Discovery finished for the session's current attachment: merge the
   * MCP tools into the session's tool registry (which the pool may already
   * have seeded with browser-lab tools — discovery must never wipe them)
   * and attach the search/call pair — plus the on-demand-tools note — to
   * every running general sub-agent that spawned before the registry held
   * anything. Callbacks of older attachments (a config change replaced the
   * manager mid-discovery) return here: only the current attachment may
   * write the registry.
   *
   * This is the one place where a prompt is still rewritten while an agent
   * runs (the session's own prompt never changes — see mcp/context.ts).
   * It stays because the alternative silently strips a capability: a child
   * spawned before discovery could never reach the MCP tools, and a child
   * that just started pays one request's prefix for the pair it needs for
   * the rest of its work. */
  private attachMcpToRunning(attachment: McpAttachment, tools: Tool[]): void {
    if (attachment !== this.handledAttachment) return;
    if (this.registry === null) return;
    this.registry.addTools(tools);
    if (this.registry.isEmpty) return;
    const pair = this.searchTools();
    for (const sub of this.options.runningAgents()) {
      if (sub.status !== "running" || sub.type !== "general") continue;
      if (sub.agent === null) continue;
      addToolsToAgent(sub.agent, pair);
      sub.agent.state.systemPrompt = withOnDemandToolsNote(
        sub.agent.state.systemPrompt,
      );
    }
  }
}
