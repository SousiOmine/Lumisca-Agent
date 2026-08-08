import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpManager, McpToolDef } from "./manager.ts";

/** Argument schemas larger than this are omitted from the description. */
const MAX_SCHEMA_CHARS = 8192;

/** Make server names safe for provider function-name rules
 * (`^[a-zA-Z0-9_-]{1,64}$`); tool names are already constrained by the
 * MCP protocol, but user-chosen server names may contain dots/spaces. */
export function sanitizeServerName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.slice(0, 64);
}

/** Build AgentTool wrappers for every tool of an McpManager. The argument
 * schema is intentionally permissive — MCP schemas are arbitrary JSON
 * Schema, so validation is delegated to the server. */
export async function createMcpTools(
  manager: McpManager,
): Promise<AgentTool[]> {
  const defs = await manager.listTools();
  return defs.map((def) => createMcpTool(manager, def));
}

function createMcpTool(manager: McpManager, def: McpToolDef): AgentTool {
  return {
    name: `mcp__${sanitizeServerName(def.server)}__${def.name}`,
    label: `${def.server}: ${def.name}`,
    description: buildDescription(def),
    parameters: Type.Object({}, { additionalProperties: Type.Any() }),
    prepareArguments: (args) =>
      (typeof args === "object" && args !== null && !Array.isArray(args)
        ? args
        : {}) as Record<string, unknown>,
    execute: async (_id, params, signal) => {
      const text = await manager.callTool(def.server, def.name, params, signal);
      return {
        content: [{ type: "text", text }],
        details: { server: def.server, tool: def.name },
      };
    },
  };
}

function buildDescription(def: McpToolDef): string {
  let description = def.description ??
    `MCP tool "${def.name}" of server "${def.server}"`;
  if (def.inputSchema !== undefined && def.inputSchema !== null) {
    const schema = JSON.stringify(def.inputSchema);
    if (schema.length <= MAX_SCHEMA_CHARS) {
      description += `\n\nArguments (JSON Schema):\n${schema}`;
    }
  }
  return description;
}
