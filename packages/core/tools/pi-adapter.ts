import type { AgentTool } from "../ai/types.ts";
import type { Infer, Tool, ToolSchema } from "./schema.ts";

/**
 * Convert a Lumisca tool into the agent runtime's AgentTool. `parameters`
 * stays plain JSON Schema: the Vercel AI SDK transport wraps it with
 * `jsonSchema()` (see ai/stream.ts), so no schema conversion is needed —
 * only this type adaptation. This is the single place where tool
 * definitions touch the agent's tool type.
 */
export function toAgentTool<P extends ToolSchema>(tool: Tool<P>): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    execute: (id, params, signal) =>
      tool.execute(id, params as Infer<P>, signal),
  };
}
