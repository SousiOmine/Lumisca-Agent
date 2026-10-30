import { ToolRegistry } from "./registry.ts";
import type { Tool } from "./schema.ts";

/**
 * The two tool registries one session holds: the main agent's and its
 * sub-agents'.
 *
 * They are separate because the two agents are not the same agent. A stella
 * session's main agent owns the conversation — its identity, the other
 * agents it may create, the routines scheduled on it — while a sub-agent is
 * a short-lived worker with one assignment: it must not be able to rewrite
 * the identity of the agent that started it, create siblings the user never
 * asked for, or schedule work that outlives its own run. Keeping one
 * registry would have handed all three to every `general` sub-agent through
 * `tool_search` (the pre-seeded tools of a session were visible to all of
 * its agents).
 *
 * What the two agents still SHARE is everything that describes where they
 * work: MCP servers, the browser lab, computer use, the PDF reader. Those
 * arrive through `addShared` and leave through `removeShared`, so a writer
 * (MCP discovery, the browser backend attach) never has to know there are
 * two registries at all. Main-only tools go through `addMainOnly`.
 *
 * The two are real registries rather than one filtered on read: MCP
 * discovery is delivered to two independent listeners (the main agent's
 * attachment host and the sub-agent hub), each of which merges its tools and
 * then attaches the search/call pair. With a filtered view, whichever
 * listener ran first could see a registry that the other had not filled yet,
 * and a sub-agent spawned in that window would get no pair at all.
 */
export class SessionToolRegistries {
  /** The main agent's registry: the shared tools plus the tools that belong
   * to this conversation's own agent. */
  readonly main: ToolRegistry = new ToolRegistry();
  /** The sub-agents' registry: the shared tools only. */
  readonly subagent: ToolRegistry = new ToolRegistry();

  /** Add tools both agents may use (MCP, browser lab, computer use, PDF). */
  addShared(tools: readonly Tool[]): void {
    this.main.addTools(tools);
    this.subagent.addTools(tools);
  }

  /** Remove shared tools by name from both (a backend detached, a server
   * removed from the config). */
  removeShared(names: Iterable<string>): void {
    this.main.removeTools(names);
    this.subagent.removeTools(names);
  }

  /** Add tools only the main agent may discover (its identity, creating
   * another agent, the routines scheduled on it). */
  addMainOnly(tools: readonly Tool[]): void {
    this.main.addTools(tools);
  }
}
