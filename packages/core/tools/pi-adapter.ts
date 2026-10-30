import type { AgentTool } from "../ai/types.ts";
import type { Infer, Tool, ToolSchema } from "./schema.ts";
import { assertSchemaBounds } from "./validate.ts";

/**
 * Convert a Lumisca tool into the agent runtime's AgentTool. `parameters`
 * stays plain JSON Schema: the Vercel AI SDK transport wraps it with
 * `jsonSchema()` (see ai/stream.ts), so no schema conversion is needed —
 * only this type adaptation. This is the single place where tool
 * definitions touch the agent's tool type.
 *
 * The declared numeric bounds are enforced here (see assertSchemaBounds), so
 * a tool never receives an out-of-range integer regardless of what the
 * provider let through.
 */
export function toAgentTool<P extends ToolSchema>(tool: Tool<P>): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    execute: (id, params, signal) => {
      assertSchemaBounds(tool.parameters, params);
      return tool.execute(id, params as Infer<P>, signal);
    },
    dispose: tool.dispose,
  };
}
