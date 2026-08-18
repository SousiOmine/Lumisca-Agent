import { TOOL_CALL } from "../shared.ts";
import type { ToolRegistryProvider } from "./registry.ts";
import {
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";

const toolCallSchema = object({
  name: string(
    "The exact name of the tool to execute (returned by tool_search)",
  ),
  args: optional(object(
    {},
    {
      additionalProperties: true,
      description: "Tool arguments as described by tool_search (optional)",
    },
  )),
});

/** Build the tool that executes a registry tool by name — the single
 * dispatch point for tools whose definitions stay out of the LLM context.
 * The inner tool's name is prefixed to the result text so the transcript
 * keeps attributing the output to the actual tool. The registry is resolved
 * through a provider, so a config change that swaps it redirects this tool
 * without replacing it on the agent. */
export function createToolCallTool(
  getRegistry: ToolRegistryProvider,
): Tool<typeof toolCallSchema> {
  return {
    name: TOOL_CALL,
    label: "Tool Call",
    description:
      "Execute a tool found with tool_search, by its exact name. Pass the " +
      "arguments the search result described. Unknown names fail — search " +
      "first. The result is prefixed with the tool name.",
    parameters: toolCallSchema,
    async execute(toolCallId, params, signal): Promise<ToolResult> {
      const result = await getRegistry().call(
        toolCallId,
        params.name,
        params.args ?? {},
        signal,
      );
      const content = result.content.map((block) =>
        block.type === "text"
          ? { type: "text" as const, text: `[${params.name}]\n${block.text}` }
          : block
      );
      return {
        content,
        details: { ...result.details, tool: params.name },
      };
    },
  };
}
