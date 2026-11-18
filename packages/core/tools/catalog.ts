import {
  browseTools,
  callTool,
  describeTool,
  searchTools,
  type ToolRegistry,
  type ToolSearchEntry,
  type ToolSearchSource,
} from "./registry.ts";
import type { Tool, ToolResult } from "./schema.ts";

/**
 * Everything one agent may call, as one list.
 *
 * A session's tools live in two places: the set the agent was built with
 * (read, bash, todo, ...) and the registry of tools that stay out of the
 * LLM context (MCP servers, the browser lab, computer use). Function
 * calling needs that split — a preloaded tool must be in the request to be
 * callable at all. Code execution does not: a script reaches a tool by
 * name, so the two sets are one catalog to the model, and moving a tool
 * between them changes nothing about how it is called.
 *
 * Both sides are read through providers because both change while the
 * session lives: MCP discovery finishes after the agent opened, and a
 * capability reseed fills the registry in place (see
 * SessionPool.applyCapabilityChange). The agent's own set never changes
 * without a rebuild.
 */
export class ToolCatalog implements ToolSearchSource {
  constructor(
    private readonly options: {
      /** The agent's preloaded tools: what the model used to see directly. */
      tools: () => readonly Tool[];
      /** The session's discoverable tools, shared with the sub-agents. */
      registry: () => ToolRegistry;
      /** Names the catalog never offers: the code runner itself (a script
       * must not run a script) and the one-tool dispatcher it replaces. */
      exclude?: readonly string[];
    },
  ) {}

  /** Every callable tool, preloaded set first. A name in both sets is kept
   * once, from the preloaded set: the agent's own definitions are the ones
   * the session was built to run. */
  list(): Tool[] {
    const excluded = new Set(this.options.exclude ?? []);
    const merged = new Map<string, Tool>();
    for (const tool of this.options.tools()) {
      if (excluded.has(tool.name)) continue;
      merged.set(tool.name, tool);
    }
    for (const tool of this.options.registry().list()) {
      if (excluded.has(tool.name) || merged.has(tool.name)) continue;
      merged.set(tool.name, tool);
    }
    return [...merged.values()];
  }

  get(name: string): Tool | undefined {
    return this.list().find((tool) => tool.name === name);
  }

  search(query: string, limit: number): ToolSearchEntry[] {
    return searchTools(this.list(), query, limit);
  }

  browse(): string {
    return browseTools(this.list());
  }

  describe(tool: Tool): ToolSearchEntry {
    return describeTool(tool);
  }

  /** Run one tool by name. Throws for an unknown name with the way to look
   * it up from inside a script, which is where this catalog is called
   * from. */
  async call(
    toolCallId: string,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.get(name);
    if (tool === undefined) {
      throw new Error(
        `Unknown tool "${name}". Use tools.tool_search({ query: "${name}" }) ` +
          "to find it, or tools.tool_search({}) to list every tool.",
      );
    }
    return await callTool(tool, toolCallId, args, signal);
  }
}
