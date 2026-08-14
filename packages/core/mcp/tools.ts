import type { Agent } from "@earendil-works/pi-agent-core";
import { toAgentTool } from "../tools/pi-adapter.ts";
import type { Tool } from "../tools/schema.ts";
import type { McpManager, McpToolDef } from "./manager.ts";
import { object } from "../tools/schema.ts";

/** Argument schemas larger than this are omitted from the description. */
const MAX_SCHEMA_CHARS = 8192;

/** The system-prompt note teaching agents about on-demand tool loading and
 * the MCP out-of-workspace boundary. Shared by every attachment site
 * (session agent, sub-agents) so the contract text stays in one place. */
export const MCP_TOOLS_PROMPT_NOTE =
  "\n\nNote: Additional tools (MCP servers, extensions) are not preloaded " +
  "into the context to keep it small. Use tool_search to find them — the " +
  "result describes each tool and its arguments — then call one with " +
  "tool_call(name, args). MCP tools (names starting with mcp__) can access " +
  "resources outside the workspace.";

/** Make server names safe for provider function-name rules
 * (`^[a-zA-Z0-9_-]{1,64}$`); tool names are already constrained by the
 * MCP protocol, but user-chosen server names may contain dots/spaces. */
export function sanitizeServerName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.slice(0, 64);
}

/** The argument schema is intentionally permissive — MCP schemas are
 * arbitrary JSON Schema, so validation is delegated to the server. */
const mcpArgsSchema = object({}, { additionalProperties: true });

/** Build Tool wrappers for every tool of an McpManager. */
export async function createMcpTools(
  manager: McpManager,
): Promise<Tool[]> {
  const defs = await manager.listTools();
  return defs.map((def) => createMcpTool(manager, def));
}

/** Add tools to a pi agent that are not already registered, appending at
 * the end so the existing tool definitions (and their prefix-cache block)
 * stay untouched. Used for the search/call tools, whose set is fixed once
 * the session's registry is populated. */
export function addToolsToAgent(agent: Agent, tools: Tool[]): void {
  const existing = new Set(agent.state.tools.map((t) => t.name));
  const added = tools.filter((tool) => !existing.has(tool.name));
  if (added.length === 0) return;
  agent.state.tools.push(...added.map(toAgentTool));
}

function createMcpTool(manager: McpManager, def: McpToolDef): Tool {
  return {
    name: `mcp__${sanitizeServerName(def.server)}__${def.name}`,
    label: `${def.server}: ${def.name}`,
    description: buildDescription(def),
    parameters: mcpArgsSchema,
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
