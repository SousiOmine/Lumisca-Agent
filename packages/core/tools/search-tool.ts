import { TOOL_SEARCH } from "../shared/mod.ts";
import type { ToolSearchProvider } from "./registry.ts";
import { integer, object, optional, string, type Tool } from "./schema.ts";

const toolSearchSchema = object({
  query: optional(
    string(
      "Search terms: tool names, categories or keywords describing what the " +
        "tool does. Omit to list everything (names only, no activation).",
    ),
  ),
  limit: optional(
    integer("Maximum number of matching tools to return (default 5, max 10)"),
  ),
});

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

/** How the model runs a tool the search found, as the result names it.
 * The two sessions that carry this tool answer differently: function
 * calling has tool_call, and a script calls the tool itself. */
export type ToolSearchCallStyle = "tool_call" | "code";

/** Build the tool that discovers the tools of a session. The result
 * (names, labels, truncated descriptions, argument schemas) is what the
 * model needs to decide which tool to call; the definitions themselves
 * never enter the LLM context. The source is resolved through a provider,
 * so a config change that swaps it (the pool rebuilds the session's
 * registry, MCP discovery lands later) redirects this tool without
 * replacing it on the agent. */
export function createToolSearchTool(
  getSource: ToolSearchProvider,
  callStyle: ToolSearchCallStyle = "tool_call",
): Tool<typeof toolSearchSchema> {
  const runOne =
    callStyle === "code"
      ? "run one from the script with `await tools.<name>(args)`"
      : "execute one with tool_call";
  return {
    name: TOOL_SEARCH,
    label: "Tool Search",
    description:
      "Find the tools this session can run and return their names, " +
      `argument schemas and descriptions; ${runOne}. ` +
      "Omitting the query lists every available tool by name. A query that " +
      'matches nothing answers with `No tools match "<query>"` followed ' +
      "by that listing, so a miss still shows what exists.",
    parameters: toolSearchSchema,
    execute: (
      _toolCallId,
      params,
    ): Promise<{
      content: [{ type: "text"; text: string }];
      details: Record<string, unknown>;
    }> => {
      const source = getSource();
      const query = (params.query ?? "").trim();
      const limit = Math.min(
        Math.max(params.limit ?? DEFAULT_SEARCH_LIMIT, 1),
        MAX_SEARCH_LIMIT,
      );
      if (query === "") {
        return Promise.resolve({
          content: [{ type: "text", text: source.browse() }],
          details: { query: "", limit },
        });
      }
      const matches = source.search(query, limit);
      if (matches.length === 0) {
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: `No tools match "${query}".\n\n${source.browse()}`,
            },
          ],
          details: { query, limit, matches: 0 },
        });
      }
      const lines = matches.map((match) => {
        return `- ${match.name} (${match.label})\n  ${match.description}`;
      });
      return Promise.resolve({
        content: [
          {
            type: "text",
            text:
              `Found ${matches.length} tool(s) matching "${query}".\n` +
              `${lines.join("\n")}\n` +
              (callStyle === "code"
                ? "Run one from the script: await tools.<name>(args)."
                : "Call one with tool_call(name, args)."),
          },
        ],
        details: { query, limit, matches: matches.length },
      });
    },
  };
}
