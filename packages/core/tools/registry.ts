import type { Tool, ToolResult } from "./schema.ts";

/**
 * Tools that are not preloaded into the LLM context, discoverable through
 * the tool_search / tool_call pair. Holding a tool in the registry keeps
 * its definition (which can be large — MCP schemas up to 8 KB) out of every
 * LLM request; the model finds it by search and executes it by name. The
 * registry is intentionally generic — MCP tools are the first tenants, but
 * any Tool can be added — so the search tool never has to know where a
 * tool came from.
 *
 * The registry is owned by the session pool (one per session) so every
 * agent of the session — the main agent and its sub-agents — shares the
 * same set, and a rebuild (model change etc.) keeps the tools searchable.
 */

/** Cap for one tool's description in a search result. The result text stays
 * in the transcript, so it must stay compact; MCP descriptions embed the
 * argument schema as JSON, so the cap still leaves room for it. */
export const MAX_SEARCH_DESCRIPTION_CHARS = 1500;

/** Cap for the browse listing (empty query), which is only an overview. */
export const MAX_BROWSE_LISTING_CHARS = 8192;

/** One tool as reported by a search: enough for the model to decide
 * whether to call it and how to build its arguments. */
export interface ToolSearchEntry {
  name: string;
  label: string;
  /** Description truncated to MAX_SEARCH_DESCRIPTION_CHARS. */
  description: string;
  /** Top-level argument names of the parameter schema (empty when the
   * schema is permissive — e.g. MCP — or has no declared properties). */
  argNames: string[];
}

/** A group of the browse listing: tools sharing a label prefix (MCP labels
 * are "server: tool", so the groups are servers). */
export interface ToolGroup {
  group: string;
  names: string[];
}

/** Resolves the session's current tool registry. The search/call tools
 * capture this instead of an instance, so a config change that rebuilds
 * the registry (the session pool replaces the MCP attachment) redirects
 * existing pairs — e.g. the ones already attached to a running sub-agent —
 * without touching the agent that holds them. */
export type ToolRegistryProvider = () => ToolRegistry;

/** Rank a tool against a search query. Name matches dominate; the label
 * (the MCP server, for MCP tools) and the description add signal. */
function score(tool: Tool, terms: string[]): number {
  const name = tool.name.toLowerCase();
  const label = tool.label.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (term.length === 0) continue;
    if (name === term) score += 100;
    if (name.includes(term)) score += 50;
    if (label.includes(term)) score += 20;
    if (description.includes(term)) score += 10;
  }
  return score;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated)`;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** Replace the whole registry (MCP discovery finished / re-ran). */
  setTools(tools: Tool[]): void {
    this.tools.clear();
    this.addTools(tools);
  }

  /** Add tools that are not already registered (idempotent). */
  addTools(tools: Tool[]): void {
    for (const tool of tools) {
      if (!this.tools.has(tool.name)) this.tools.set(tool.name, tool);
    }
  }

  get count(): number {
    return this.tools.size;
  }

  get isEmpty(): boolean {
    return this.tools.size === 0;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Ranked keyword search over names, labels and descriptions. An empty
   * query matches nothing — callers use `browse()` for the overview. */
  search(query: string, limit: number): ToolSearchEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (terms.length === 0) return [];
    const ranked = [...this.tools.values()]
      .map((tool) => ({ tool, score: score(tool, terms) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
      );
    return ranked.slice(0, limit).map((entry) => this.describe(entry.tool));
  }

  /** Browse listing: every tool grouped by its label prefix (the MCP
   * server, for MCP tools), names only, capped at MAX_BROWSE_LISTING_CHARS.
   * `limit` bounds the names per group; overflow is announced so the model
   * knows the listing is not exhaustive. */
  browse(groupLimit = 50): string {
    const groups = new Map<string, string[]>();
    const overflow = new Map<string, number>();
    for (
      const tool of [...this.tools.values()].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    ) {
      const group = labelPrefix(tool.label);
      const names = groups.get(group) ?? [];
      if (names.length < groupLimit) {
        names.push(tool.name);
      } else {
        overflow.set(group, (overflow.get(group) ?? 0) + 1);
      }
      groups.set(group, names);
    }
    const lines = [
      `${this.tools.size} tools available across ${groups.size} groups; ` +
      "search for a specific tool with tool_search.",
    ];
    for (const [group, names] of groups) {
      const hidden = overflow.get(group) ?? 0;
      lines.push(
        `${group} (${names.length}${
          hidden > 0 ? `; +${hidden} more — search with tool_search` : ""
        }): ${names.join(", ")}`,
      );
    }
    let out = lines.join("\n");
    if (out.length > MAX_BROWSE_LISTING_CHARS) {
      out = `${out.slice(0, MAX_BROWSE_LISTING_CHARS)}\n… (truncated)`;
    }
    return out;
  }

  /** The search-result metadata of one tool. */
  describe(tool: Tool): ToolSearchEntry {
    return {
      name: tool.name,
      label: tool.label,
      description: truncate(tool.description, MAX_SEARCH_DESCRIPTION_CHARS),
      argNames: argumentNames(tool),
    };
  }

  /** Execute a registered tool by name, applying its prepareArguments shim.
   * Argument validation is deliberately not performed here — tool_call's
   * schema is permissive, and validating is the tool's own contract (MCP
   * tools delegate it to their server; extension tools validate inside
   * their execute). Throws for unknown names — the caller turns that into
   * an error tool result. */
  async call(
    toolCallId: string,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(
        `Unknown tool ${name}. Use tool_search to find available tools.`,
      );
    }
    const prepared = tool.prepareArguments !== undefined
      ? tool.prepareArguments(args)
      : args;
    return await tool.execute(
      toolCallId,
      prepared as never,
      signal,
    );
  }
}

/** The group key of a tool: the part of its label before ": " (MCP labels
 * are "server: tool"), or the whole label when there is no prefix. */
function labelPrefix(label: string): string {
  const colon = label.indexOf(": ");
  return colon > 0 ? label.slice(0, colon) : label;
}

/** Top-level argument names of a tool's parameter schema; empty for
 * permissive schemas (MCP delegates validation to its server). */
function argumentNames(tool: Tool): string[] {
  const parameters = tool.parameters;
  if (
    typeof parameters === "object" && parameters !== null &&
    "properties" in parameters && parameters.properties !== undefined
  ) {
    return Object.keys(parameters.properties);
  }
  return [];
}
