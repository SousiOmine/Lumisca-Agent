import { TOOL_SEARCH } from "../shared.ts";
import type { ToolRegistryProvider } from "./registry.ts";
import { integer, object, optional, string, type Tool } from "./schema.ts";

const toolSearchSchema = object({
  query: optional(string(
    "Search terms: tool names, categories or keywords describing what the " +
      "tool does. Omit to list everything (names only, no activation).",
  )),
  limit: optional(integer(
    "Maximum number of matching tools to return (default 5, max 10)",
  )),
});

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

/** Build the tool that discovers tools held in the registry. The result
 * (names, labels, truncated descriptions) is what the model needs to decide
 * which tool to call; the definitions themselves never enter the LLM
 * context. The registry is resolved through a provider, so a config change
 * that swaps it (the pool rebuilds the session's registry) redirects this
 * tool without replacing it on the agent. */
export function createToolSearchTool(
  getRegistry: ToolRegistryProvider,
): Tool<typeof toolSearchSchema> {
  return {
    name: TOOL_SEARCH,
    label: "Tool Search",
    description:
      "Find tools that are not preloaded into this session's context " +
      "(MCP tools, extensions). Returns matching tools with their names " +
      "and descriptions — then execute one with tool_call. " +
      "Omit the query to list every available tool (names only).",
    parameters: toolSearchSchema,
    execute: (
      _toolCallId,
      params,
    ): Promise<
      {
        content: [{ type: "text"; text: string }];
        details: Record<string, unknown>;
      }
    > => {
      const registry = getRegistry();
      const query = (params.query ?? "").trim();
      const limit = Math.min(
        Math.max(params.limit ?? DEFAULT_SEARCH_LIMIT, 1),
        MAX_SEARCH_LIMIT,
      );
      if (query === "") {
        return Promise.resolve({
          content: [{ type: "text", text: registry.browse() }],
          details: { query: "", limit },
        });
      }
      const matches = registry.search(query, limit);
      if (matches.length === 0) {
        return Promise.resolve({
          content: [{
            type: "text",
            text: `No tools match "${query}".\n\n${registry.browse()}`,
          }],
          details: { query, limit, matches: 0 },
        });
      }
      const lines = matches.map((match) => {
        return `- ${match.name} (${match.label})\n  ${match.description}`;
      });
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Found ${matches.length} tool(s) matching "${query}".\n` +
            `${lines.join("\n")}\n` +
            "Call one with tool_call(name, args).",
        }],
        details: { query, limit, matches: matches.length },
      });
    },
  };
}
