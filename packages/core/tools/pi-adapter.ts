import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Infer, Tool, ToolSchema } from "./schema.ts";

/**
 * Convert a Lumisca tool into pi's AgentTool. `parameters` stays plain
 * JSON Schema: pi's validateToolArguments explicitly handles schemas
 * without TypeBox Kind markers (manual coercion + Ajv validation), so no
 * schema conversion is needed — only this type adaptation. This is the
 * single place where tool definitions touch pi's tool type.
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
