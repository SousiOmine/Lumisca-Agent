/**
 * The agent's own MCP server administration: `mcp_add`, `mcp_remove` and
 * `mcp_list` over the app-level config — the list Settings → MCP servers
 * shows, which every workspace and every session uses.
 *
 * Discoverable through tool_search rather than preloaded (most
 * conversations never touch the config), and main agent only: the config
 * outlives any sub-agent's run (see tools/registries.ts).
 *
 * `mcp_add` runs the same connection test as the settings UI before it
 * enables "add" (see McpService.testServer): a mistyped command must not
 * enter the config unnoticed, and the agent learns which tools the server
 * actually offers instead of promising names it guessed.
 */
import { CoreError } from "../errors.ts";
import { serializeMcpServers } from "../shared/mcp-config.ts";
import {
  TOOL_MCP_ADD,
  TOOL_MCP_LIST,
  TOOL_MCP_REMOVE,
} from "../shared/tool-names.ts";
import {
  array,
  boolean,
  object,
  optional,
  string,
  stringMap,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import type { McpInfo, McpServerConfig, McpServerInfo } from "./config.ts";
import type { McpTestResult } from "./service.ts";

/** The MCP admin surface the tools need (implemented by McpService). */
export interface McpAdmin {
  /** The app-level config with its live per-server statuses. */
  getAppMcpInfo(): McpInfo;
  /** Add one server to the app-level config (throws `conflict` when the
   * name is taken). */
  addAppServer(server: McpServerConfig): McpInfo;
  /** Remove one server by name (throws `not_found` when it is not
   * configured). */
  removeAppServer(name: string): McpInfo;
  /** Connect to a one-server config, list its tools, disconnect. */
  testServer(text: string): Promise<McpTestResult>;
}

/** Names of the MCP administration tools (discoverable, main-only). */
export const MCP_ADMIN_TOOL_NAMES = [
  TOOL_MCP_ADD,
  TOOL_MCP_REMOVE,
  TOOL_MCP_LIST,
] as const;

/** How many discovered tool names `mcp_add` reports before summarizing. */
const MAX_REPORTED_TOOLS = 20;

const addSchema = object({
  name: string(
    "The server's name: its label in Settings → MCP servers and the group " +
      "its tools are listed under.",
  ),
  command: optional(string(
    "stdio servers: the program to run (for example npx). Pass either " +
      "command or url, never both.",
  )),
  args: optional(array(
    string(),
    "stdio servers: one argument per element (each element is passed " +
      "as-is; do not quote or join them).",
  )),
  env: optional(stringMap(
    "stdio servers: environment variables for the process, each value a " +
      "string (for example TOKEN=...).",
  )),
  cwd: optional(string(
    "stdio servers: working directory. The app-level config is shared by " +
      "every session, and a relative path resolves against each session's " +
      "own workspace, so prefer an absolute path.",
  )),
  url: optional(string(
    "HTTP servers: the streamable HTTP endpoint (http or https). Pass " +
      "either command or url, never both.",
  )),
  headers: optional(stringMap(
    "HTTP servers: request headers, for example Authorization.",
  )),
  verify: optional(boolean(
    "Test the connection before saving (default true). A failed test saves " +
      "nothing, so a wrong command is caught here; false saves without the " +
      "test, for a first run that takes longer than the test allows.",
  )),
});

const removeSchema = object({
  name: string(
    "The name of the server to remove, as mcp_list reports it.",
  ),
});

const listSchema = object({});

/** The trimmed name, or a failure saying the name is what is missing. */
function requireName(value: string): string {
  const name = value.trim();
  if (name === "") {
    throw new CoreError("name must not be empty", "invalid");
  }
  return name;
}

/** One status line of `mcp_list`. Disabled servers come first: the manager
 * reports them as "ok" with no tools, which would read as connected. */
function statusText(server: McpServerInfo): string {
  if (!server.enabled) return "disabled";
  if (server.needsAuth === true) return "needs sign-in (Settings)";
  if (server.error !== undefined) return `failed: ${server.error}`;
  if (server.status === "not_started") return "not started yet";
  return `connected, ${server.toolCount} tool(s)`;
}

/** What the connection test found, as one line. */
function testSummary(tools: McpTestResult["tools"]): string {
  if (tools.length === 0) {
    return "The connection test passed, but the server lists no tools.";
  }
  const names = tools.slice(0, MAX_REPORTED_TOOLS).map((tool) => tool.name);
  const hidden = tools.length - names.length;
  return `The connection test passed: ${tools.length} tool(s): ` +
    `${names.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}.`;
}

/** Build the three MCP administration tools over one admin surface. */
export function createMcpAdminTools(admin: McpAdmin): Tool[] {
  const add: Tool<typeof addSchema> = {
    name: TOOL_MCP_ADD,
    label: "MCP Add",
    description:
      "Add an MCP server to the app-level config (the list Settings → MCP " +
      "servers shows), which every workspace and every session uses. Pass " +
      "command (with optional args, env, cwd) for a local stdio server, or " +
      "url (with optional headers) for a streamable HTTP server — never " +
      "both. The server is connected and its tools listed before anything " +
      "is saved, so a wrong command fails here and changes nothing; " +
      "verify=false saves without that test. A server that asks for a " +
      "sign-in is saved anyway and the user signs in from Settings. Its " +
      "tools are discoverable with tool_search once it connects.",
    parameters: addSchema,
    async execute(_toolCallId, params): Promise<ToolResult> {
      const name = requireName(params.name);
      const command = params.command?.trim();
      const url = params.url?.trim();
      if ((command === undefined) === (url === undefined)) {
        throw new CoreError(
          `MCP server "${name}" needs either command (stdio) or url (HTTP), ` +
            "not both.",
          "invalid",
        );
      }
      if (command === "") {
        throw new CoreError("command must not be empty", "invalid");
      }
      if (url === "") {
        throw new CoreError("url must not be empty", "invalid");
      }
      if (url !== undefined) {
        // The serializer drops these for an HTTP server, so passing them
        // would look accepted and configure nothing.
        for (const field of ["args", "env", "cwd"] as const) {
          if (params[field] !== undefined) {
            throw new CoreError(
              `${field} belongs to a stdio server (one with a command); ` +
                `"${name}" has a url.`,
              "invalid",
            );
          }
        }
      }
      if (command !== undefined && params.headers !== undefined) {
        throw new CoreError(
          `headers belongs to an HTTP server (one with a url); "${name}" ` +
            "has a command.",
          "invalid",
        );
      }
      const server: McpServerConfig = {
        name,
        type: command !== undefined ? "stdio" : "http",
        ...(command !== undefined ? { command } : {}),
        args: params.args ?? [],
        env: params.env ?? {},
        ...(params.cwd !== undefined && params.cwd.trim() !== ""
          ? { cwd: params.cwd.trim() }
          : {}),
        ...(url !== undefined ? { url } : {}),
        headers: params.headers ?? {},
        enabled: true,
      };
      // Checked before the test: a taken name must not cost a connection
      // attempt, and the probe would tell us nothing about the conflict.
      const existing = admin.getAppMcpInfo();
      if (existing.servers.some((s) => s.name === name)) {
        throw new CoreError(
          `An MCP server named "${name}" is already configured. Remove it ` +
            "first with mcp_remove, or choose another name.",
          "conflict",
        );
      }
      const verify = params.verify ?? true;
      let tested: McpTestResult | undefined;
      if (verify) {
        tested = await admin.testServer(serializeMcpServers([server]));
        if (!tested.ok && tested.needsAuth !== true) {
          throw new CoreError(
            `MCP server "${name}" was not added: the connection test ` +
              `failed: ${tested.error}. Nothing was saved. Fix the command ` +
              "or url and try again, or pass verify=false to save it " +
              "without a test.",
            "invalid",
          );
        }
      }
      admin.addAppServer(server);
      const lines = [
        `Added MCP server "${name}" (${server.type}) to the app-level ` +
        "config; every workspace and every session uses it.",
      ];
      if (tested?.ok === true) lines.push(testSummary(tested.tools));
      if (tested?.needsAuth === true) {
        lines.push(
          "The server answered that a sign-in is required. Open Settings → " +
            "MCP servers and sign in to it; until then it does not start.",
        );
      }
      if (!verify) lines.push("Saved without a connection test.");
      lines.push(
        "It is enabled; its tools become discoverable with tool_search once " +
          "the server connects.",
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          server: name,
          verified: verify,
          ...(tested?.ok === true ? { toolCount: tested.tools.length } : {}),
        },
      };
    },
  };

  const remove: Tool<typeof removeSchema> = {
    name: TOOL_MCP_REMOVE,
    label: "MCP Remove",
    description:
      "Remove an MCP server from the app-level config by name (the names " +
      "mcp_list reports). Its tools stop being available in every session. " +
      "Fails when no server of that name is configured.",
    parameters: removeSchema,
    execute(_toolCallId, params): Promise<ToolResult> {
      const name = requireName(params.name);
      const before = admin.getAppMcpInfo();
      if (!before.servers.some((s) => s.name === name)) {
        throw new CoreError(
          `No MCP server named "${name}" is configured. Use mcp_list to see ` +
            "the servers in the app-level config.",
          "not_found",
        );
      }
      const after = admin.removeAppServer(name);
      const remaining = after.servers.length;
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Removed MCP server "${name}" from the app-level config. ` +
            "Its tools are no longer available in any session.\n" +
            (remaining === 0
              ? "No MCP servers are configured now."
              : `${remaining} server(s) remain.`),
        }],
        details: { server: name, remaining },
      });
    },
  };

  const list: Tool<typeof listSchema> = {
    name: TOOL_MCP_LIST,
    label: "MCP List",
    description:
      "List the MCP servers in the app-level config (the list Settings → " +
      "MCP servers shows) with their type, enabled state and live status: " +
      "connected and how many tools, failed with the error, or needs a " +
      "sign-in. These servers apply to every workspace and every session; " +
      "a workspace's .mcp.json can add more, which this tool does not edit.",
    parameters: listSchema,
    execute(): Promise<ToolResult> {
      const info = admin.getAppMcpInfo();
      if (info.servers.length === 0) {
        return Promise.resolve({
          content: [{
            type: "text",
            text: "No MCP servers are configured in the app-level config " +
              "(Settings → MCP servers). Add one with mcp_add.",
          }],
          details: { count: 0 },
        });
      }
      const lines = [
        "MCP servers in the app-level config (Settings → MCP servers):",
        ...info.servers.map((server) =>
          `- ${server.name} (${server.type}${
            server.enabled ? "" : ", disabled"
          }): ${statusText(server)}`
        ),
        "",
        "Every workspace and session uses these. A workspace's .mcp.json or " +
        "an agent plugin can add more servers (a workspace entry with the " +
        "same name overrides one of these); this tool edits only the " +
        "app-level config.",
      ];
      return Promise.resolve({
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: info.servers.length },
      });
    },
  };

  return [add, remove, list];
}
