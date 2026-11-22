import type { Tool, ToolResult } from "../ports/tool.ts";
import { assertSchemaBounds } from "../ports/validate.ts";
import { truncatedHeadNote, truncateHead } from "./truncate.ts";

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
 *
 * The ranking, listing and dispatch live as functions over `Tool[]` rather
 * than as methods only: the scripting tool call searches a set that is the
 * agent's preloaded tools PLUS this registry (see tools/catalog.ts), and both
 * sides
 * must describe and run a tool the same way or the model would get two
 * answers for one name.
 */

/** Cap for one tool's description in a search result. The result text stays
 * in the transcript, so it must stay compact; MCP descriptions embed the
 * argument schema as JSON, so the cap still leaves room for it. */
export const MAX_SEARCH_DESCRIPTION_CHARS = 1500;

/** Cap for one tool's serialized parameter schema before it is appended to
 * a search result (mirrors the MCP tools' MAX_SCHEMA_CHARS; anything this
 * big would dominate the truncated result anyway). */
const MAX_PARAMETER_SCHEMA_CHARS = 8192;

/** Cap for the browse listing (empty query), which is only an overview. */
const MAX_BROWSE_LISTING_CHARS = 8192;

/** One tool as reported by a search: enough for the model to decide
 * whether to call it and how to build its arguments. */
export interface ToolSearchEntry {
  name: string;
  label: string;
  /** Description truncated to MAX_SEARCH_DESCRIPTION_CHARS. */
  description: string;
}

/** What the search and listing tools need from whatever holds the tools: a
 * registry, or the catalog the scripting tool call searches. */
export interface ToolSearchSource {
  search(query: string, limit: number): ToolSearchEntry[];
  browse(): string;
}

/** Resolves the session's current tool source. The search/call tools
 * capture this instead of an instance, so a config change that rebuilds
 * the registry (the session pool replaces the MCP attachment) redirects
 * existing pairs — e.g. the ones already attached to a running sub-agent —
 * without touching the agent that holds them. */
export type ToolSearchProvider = () => ToolSearchSource;

/** Resolves the session's current tool registry (the dispatch side). */
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

/** The search-result metadata of one tool: the description plus its
 * parameter schema when it carries explicit properties, so the model
 * sees the argument names/defaults it must pass. MCP tools cover the same
 * ground by embedding their schema in the description (their registry
 * `parameters` stay permissive); tools with typed schemas (browser-lab,
 * future extensions) get the schema appended here so every tool reports its
 * arguments the same way. */
export function describeTool(tool: Tool): ToolSearchEntry {
  const { text, truncated } = truncateHead(
    tool.description + parameterSchemaText(tool.parameters),
    MAX_SEARCH_DESCRIPTION_CHARS,
  );
  return {
    name: tool.name,
    label: tool.label,
    description: truncated
      ? text + truncatedHeadNote("description", MAX_SEARCH_DESCRIPTION_CHARS)
      : text,
  };
}

/** Ranked keyword search over names, labels and descriptions. An empty
 * query matches nothing — callers use {@link browseTools} for the
 * overview. */
export function searchTools(
  tools: readonly Tool[],
  query: string,
  limit: number,
): ToolSearchEntry[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];
  const ranked = tools
    .map((tool) => ({ tool, score: score(tool, terms) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
    );
  return ranked.slice(0, limit).map((entry) => describeTool(entry.tool));
}

/** Browse listing: every tool grouped by its label prefix (the MCP
 * server, for MCP tools), names only, capped at MAX_BROWSE_LISTING_CHARS.
 * `limit` bounds the names per group; overflow is announced so the model
 * knows the listing is not exhaustive. */
export function browseTools(tools: readonly Tool[], groupLimit = 50): string {
  const groups = new Map<string, string[]>();
  const overflow = new Map<string, number>();
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
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
    `${tools.length} tools available across ${groups.size} groups; ` +
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
  const { text, truncated } = truncateHead(
    lines.join("\n"),
    MAX_BROWSE_LISTING_CHARS,
  );
  return truncated
    ? text + truncatedHeadNote("listing", MAX_BROWSE_LISTING_CHARS)
    : text;
}

/** Run one tool with the arguments a model supplied, applying its
 * prepareArguments shim and the bounds its schema declares (see
 * assertSchemaBounds; a discoverable tool is called through tool_call or a
 * code script, neither of which passed through the agent adapter).
 * Field-level types stay the tool's own contract: the calling schemas are
 * permissive, and MCP tools delegate validation to their server. */
export async function callTool(
  tool: Tool,
  toolCallId: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const prepared =
    tool.prepareArguments !== undefined ? tool.prepareArguments(args) : args;
  assertSchemaBounds(tool.parameters, prepared);
  return await tool.execute(toolCallId, prepared as never, signal);
}

export class ToolRegistry implements ToolSearchSource {
  private readonly tools = new Map<string, Tool>();
  /** Bumped by every mutation, so a reader that caches a merge of this
   * registry with another set (see tools/catalog.ts) can tell a stale
   * snapshot from a current one without copying the whole map. */
  private version = 0;

  /** How many times this registry has changed. Compared for equality only. */
  get revision(): number {
    return this.version;
  }

  /** Replace the whole registry (MCP discovery finished / re-ran). */
  setTools(tools: Tool[]): void {
    this.tools.clear();
    this.addTools(tools);
  }

  /** Add tools that are not already registered (idempotent). */
  addTools(tools: readonly Tool[]): void {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) continue;
      this.tools.set(tool.name, tool);
      this.version++;
    }
  }

  /** Remove tools by name (no-op for unknown names); returns how many were
   * removed. Used when a tool family's backing resource goes away — the
   * session pool drops the browser-lab tools when the browser backend is
   * detached, so rebuilt agents stop seeing them. */
  removeTools(names: Iterable<string>): number {
    let removed = 0;
    for (const name of names) {
      if (!this.tools.delete(name)) continue;
      removed++;
      this.version++;
    }
    return removed;
  }

  get count(): number {
    return this.tools.size;
  }

  get isEmpty(): boolean {
    return this.tools.size === 0;
  }

  /** Every tool, in insertion order. */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** See {@link searchTools}. */
  search(query: string, limit: number): ToolSearchEntry[] {
    return searchTools(this.list(), query, limit);
  }

  /** See {@link browseTools}. */
  browse(groupLimit = 50): string {
    return browseTools(this.list(), groupLimit);
  }

  /** See {@link describeTool}. */
  describe(tool: Tool): ToolSearchEntry {
    return describeTool(tool);
  }

  /** Execute a registered tool by name. Throws for unknown names — the
   * caller turns that into an error tool result. */
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
    return await callTool(tool, toolCallId, args, signal);
  }
}

/** The group key of a tool: the part of its label before ": " (MCP labels
 * are "server: tool"), or the whole label when there is no prefix. */
function labelPrefix(label: string): string {
  const colon = label.indexOf(": ");
  return colon > 0 ? label.slice(0, colon) : label;
}

/** Serialize a tool's parameter schema for a search result, or "" when the
 * schema carries no explicit properties (MCP tools delegate validation to
 * their remote server and embed the schema in their description instead;
 * argument-less tools like browser_close have nothing to report). */
function parameterSchemaText(parameters: Tool["parameters"]): string {
  if (parameters.type !== "object") return "";
  // SchemaStringMap (env-var-style) has no explicit properties either.
  if (!("properties" in parameters)) return "";
  if (Object.keys(parameters.properties).length === 0) return "";
  const schema = JSON.stringify(parameters);
  if (schema.length > MAX_PARAMETER_SCHEMA_CHARS) return "";
  return `\n\nArguments (JSON Schema):\n${schema}`;
}
