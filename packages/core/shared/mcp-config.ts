/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / pi imports), bundled into the browser client. */

/** Minimal server-config shape accepted by serializeMcpServers (config
 * fields only; the live status fields of McpServerInfo are ignored). */
export interface McpServerConfigLike {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
}

/** Serialize a list of MCP server configs into `.mcp.json` text (the
 * app-level config the settings UI PUTs and the workspace file format).
 * Shared by the core (serializeMcpConfig) and the web settings UI so the
 * format can never drift between them. */
export function serializeMcpServers(servers: McpServerConfigLike[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    const entry: Record<string, unknown> = {};
    if (server.type === "stdio") {
      entry.command = server.command;
      if (server.args.length > 0) entry.args = server.args;
    } else {
      entry.url = server.url;
      if (Object.keys(server.headers).length > 0) {
        entry.headers = server.headers;
      }
    }
    if (Object.keys(server.env).length > 0) entry.env = server.env;
    if (server.cwd !== undefined) entry.cwd = server.cwd;
    if (!server.enabled) entry.enabled = false;
    mcpServers[server.name] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2) + "\n";
}
