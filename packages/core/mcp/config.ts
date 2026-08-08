import { isAbsolute, join } from "node:path";

/** One configured MCP server (normalized form of `.mcp.json`). */
export interface McpServerConfig {
  name: string;
  /** "stdio" servers are child processes; "http" servers use streamable HTTP. */
  type: "stdio" | "http";
  command?: string;
  args: string[];
  env: Record<string, string>;
  /** Working directory for stdio servers; relative paths resolve against
   * the workspace root. */
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  /** `enabled: false` keeps the config while excluding the server. */
  enabled: boolean;
}

export interface McpConfig {
  servers: McpServerConfig[];
  /** Absolute path of the `.mcp.json` this config was read from. */
  filePath: string;
}

/** One server as reported to the settings UI (config + live status). */
export interface McpServerInfo {
  name: string;
  type: "stdio" | "http";
  enabled: boolean;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  /** Number of tools discovered (0 until a session attached the server). */
  toolCount: number;
  status: "ok" | "error" | "not_started";
  error?: string;
}

/** The MCP configuration surface for the settings UI and API. */
export interface McpInfo {
  filePath: string;
  /** Whether the `.mcp.json` file currently exists on disk. */
  exists: boolean;
  servers: McpServerInfo[];
}

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

/** The `.mcp.json` file at the workspace root (Claude Code compatible). */
export const MCP_CONFIG_FILE = ".mcp.json";

/** Settings-table key holding the app-level (global) MCP configuration.
 * The value is the same `.mcp.json` format; it applies to every workspace
 * and is merged with each workspace's own `.mcp.json` (workspace wins on
 * name collisions). */
export const APP_MCP_SETTINGS_KEY = "mcp_servers";

/** Virtual file path used when parsing the app-level config. */
export const APP_MCP_SOURCE = "app settings";

/** Expand `${VAR}` references from the process environment. */
export function expandEnv(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match, name: string) => Deno.env.get(name) ?? match,
  );
}

function asString(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new McpConfigError(`${what} must be a string`);
  }
  return value;
}

function asStringMap(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new McpConfigError(`${what} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      throw new McpConfigError(`${what}.${key} must be a string`);
    }
    out[key] = expandEnv(entry);
  }
  return out;
}

function asStringArray(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new McpConfigError(`${what} must be an array of strings`);
  }
  return value.map((v) => expandEnv(v as string));
}

/** Parse `.mcp.json` content into normalized server configs. Throws
 * McpConfigError on invalid input. */
export function parseMcpConfig(text: string, filePath: string): McpConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new McpConfigError(
      `${filePath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new McpConfigError(`${filePath} must contain a JSON object`);
  }
  const mcpServers = (raw as Record<string, unknown>).mcpServers;
  if (mcpServers === undefined || mcpServers === null) {
    throw new McpConfigError(`${filePath} is missing the "mcpServers" key`);
  }
  if (typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    throw new McpConfigError(`"mcpServers" must be an object`);
  }

  const servers: McpServerConfig[] = [];
  for (
    const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)
  ) {
    if (!name.trim()) {
      throw new McpConfigError(`MCP server name must not be empty`);
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new McpConfigError(`MCP server "${name}" must be an object`);
    }
    const cfg = entry as Record<string, unknown>;
    const command = asString(cfg.command, `"${name}".command`);
    const url = asString(cfg.url, `"${name}".url`);
    if (command === undefined && url === undefined) {
      throw new McpConfigError(
        `MCP server "${name}" needs either "command" (stdio) or "url" (HTTP)`,
      );
    }
    if (command !== undefined && url !== undefined) {
      throw new McpConfigError(
        `MCP server "${name}" must specify either "command" or "url", not both`,
      );
    }
    const rawCwd = asString(cfg.cwd, `"${name}".cwd`);
    servers.push({
      name,
      type: url !== undefined ? "http" : "stdio",
      command: command !== undefined ? expandEnv(command) : undefined,
      args: asStringArray(cfg.args, `"${name}".args`),
      env: asStringMap(cfg.env, `"${name}".env`),
      cwd: rawCwd !== undefined ? expandEnv(rawCwd) : undefined,
      url: url !== undefined ? expandEnv(url) : undefined,
      headers: asStringMap(cfg.headers, `"${name}".headers`),
      enabled: cfg.enabled === undefined ? true : cfg.enabled === true,
    });
  }
  return { servers, filePath };
}

/** Load the MCP config for a workspace root. Missing or empty `.mcp.json`
 * yields an empty config; parse errors propagate as McpConfigError. */
export function loadMcpConfig(workspaceRoot: string): McpConfig {
  const filePath = join(workspaceRoot, MCP_CONFIG_FILE);
  let text: string;
  try {
    text = Deno.readTextFileSync(filePath);
  } catch {
    return { servers: [], filePath };
  }
  return parseMcpConfig(text, filePath);
}

/** Serialize a config back to `.mcp.json` format. */
export function serializeMcpConfig(config: McpConfig): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of config.servers) {
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

/** Resolve a server's working directory: explicit cwd (absolute or
 * workspace-relative), else the workspace root. */
export function resolveServerCwd(
  server: McpServerConfig,
  workspaceRoot: string,
): string {
  if (server.cwd === undefined) return workspaceRoot;
  return isAbsolute(server.cwd) ? server.cwd : join(workspaceRoot, server.cwd);
}
