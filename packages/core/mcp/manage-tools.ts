/**
 * The agent's own MCP server administration: `mcp_add`, `mcp_remove` and
 * `mcp_list`.
 *
 * A code-mode session has one list, the app-level config, whose servers run
 * on the host. A stella conversation has two: that same app-level list,
 * shared by every agent and every code-mode session, and the agent's own
 * list, whose servers run inside its machine.
 *
 * The list a server belongs to follows from what the server is. A command
 * server is a process, so it runs wherever it is started, and on this side
 * that is the agent's machine: it always lands in the agent's own list. An
 * HTTP server is reached by URL from either side, so it can be shared, and
 * its scope is the caller's choice, defaulting to the shared list.
 *
 * Discoverable through tool_search rather than preloaded (most
 * conversations never touch the config), and main agent only: the config
 * outlives any sub-agent's run (see tools/registries.ts).
 *
 * `mcp_add` runs the same connection test as the settings UI before it
 * enables "add": a mistyped command must not enter the config unnoticed, and
 * the agent learns which tools the server actually offers instead of
 * promising names it guessed. The probe runs where the server would run, so
 * an agent's server is tested inside its machine.
 */
import { CoreError } from "../errors.ts";
import {
  array,
  boolean,
  object,
  optional,
  string,
  stringMap,
  type Tool,
  type ToolResult,
} from "../ports/tool.ts";
import type { McpServerConfig } from "../shared/mcp-config.ts";
import { serializeMcpServers } from "../shared/mcp-config.ts";
import {
  TOOL_MCP_ADD,
  TOOL_MCP_LIST,
  TOOL_MCP_REMOVE,
} from "../shared/tool-names.ts";
import type { McpInfo, McpServerInfo } from "./config.ts";
import type { McpTestResult } from "./service.ts";

/** Which list a server belongs to. */
export type McpScope = "global" | "agent";

/** The MCP admin surface the tools need (implemented by McpService).
 *
 * The agent's own half is optional: a code-mode session has no machine and
 * therefore no second list. */
export interface McpAdmin {
  /** The app-level config with its live per-server statuses. */
  getAppMcpInfo(): McpInfo;
  /** Add one server to the app-level config (throws `conflict` when the
   * name is taken). */
  addAppServer(server: McpServerConfig): McpInfo;
  /** Remove one server by name (throws `not_found` when it is not
   * configured). */
  removeAppServer(name: string): McpInfo;
  /** Connect to a one-server config, list its tools, disconnect. Runs on the
   * host. */
  testServer(text: string): Promise<McpTestResult>;
  /** The agent's own config with its live statuses. Present only in a stella
   * conversation. */
  getAgentMcpInfo?(): McpInfo;
  /** Add one server to the agent's own config. */
  addAgentServer?(server: McpServerConfig): McpInfo;
  /** Remove one server from the agent's own config by name. */
  removeAgentServer?(name: string): McpInfo;
  /** The same probe, run inside the agent's machine. */
  testAgentServer?(text: string): Promise<McpTestResult>;
}

/** Names of the MCP administration tools (discoverable, main-only). */
export const MCP_ADMIN_TOOL_NAMES = [
  TOOL_MCP_ADD,
  TOOL_MCP_REMOVE,
  TOOL_MCP_LIST,
] as const;

/** How many discovered tool names `mcp_add` reports before summarizing. */
const MAX_REPORTED_TOOLS = 20;

/** The scope argument, read leniently: absent and blank both mean "the
 * caller did not choose", which each tool resolves its own way. */
function readScope(raw: string | undefined): McpScope | undefined {
  const value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  if (value === "global" || value === "agent") return value;
  throw new CoreError(
    `scope must be "global" or "agent", got "${value}".`,
    "invalid",
  );
}

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
  if (server.needsAuth === true) return "needs sign-in";
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
  return (
    `The connection test passed: ${tools.length} tool(s): ` +
    `${names.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}.`
  );
}

/** Where a scope's servers run, in the words the agent has to know. */
function scopeSummary(scope: McpScope): string {
  return scope === "agent"
    ? "inside this agent's machine, and only this agent sees it"
    : "on the host, shared by every agent and every code-mode session";
}

/** Build the three MCP administration tools over one admin surface. */
export function createMcpAdminTools(admin: McpAdmin): Tool[] {
  // Whether this conversation has the agent's own list. It decides both what
  // the scope argument offers and where an unspecified server goes.
  const hasAgent = admin.getAgentMcpInfo !== undefined;
  const scopeHelp = hasAgent
    ? 'Which list to put the server in. "global" is shared by every agent ' +
      "and every code-mode session and runs on the host; it needs a url. " +
      '"agent" belongs to this conversation\'s agent, runs inside its ' +
      "machine, and is the only place a command server can go. Omit it " +
      "for an HTTP server to use the shared list."
    : "Which list to put the server in. This session has only the shared " +
      "list, so omit it.";

  const addSchema = object({
    name: string(
      "The server's name: its label in the MCP list of Settings and the " +
        "group its tools are listed under.",
    ),
    scope: optional(string(scopeHelp)),
    command: optional(
      string(
        "stdio servers: the program to run inside the agent's machine (for " +
          "example npx). Pass either command or url, never both.",
      ),
    ),
    args: optional(
      array(
        string(),
        "stdio servers: one argument per element (each element is passed " +
          "as-is; do not quote or join them).",
      ),
    ),
    env: optional(
      stringMap(
        "stdio servers: environment variables for the process, each value a " +
          "string (for example TOKEN=...).",
      ),
    ),
    cwd: optional(
      string(
        "stdio servers: working directory inside the machine. A relative " +
          "path resolves against the agent's home folder, so prefer an " +
          "absolute path.",
      ),
    ),
    url: optional(
      string(
        "HTTP servers: the streamable HTTP endpoint (http or https). Pass " +
          "either command or url, never both.",
      ),
    ),
    headers: optional(
      stringMap("HTTP servers: request headers, for example Authorization."),
    ),
    verify: optional(
      boolean(
        "Test the connection before saving (default true). A failed test " +
          "saves nothing, so a wrong command is caught here; false saves " +
          "without the test, for a first run that takes longer than the " +
          "test allows.",
      ),
    ),
  });

  const removeSchema = object({
    name: string("The name of the server to remove, as mcp_list reports it."),
    scope: optional(
      string(
        "Which list to remove it from. Omit it unless the same name is in " +
          "both lists: the shared list is searched first, then this agent's.",
      ),
    ),
  });

  const listSchema = object({});

  const add: Tool<typeof addSchema> = {
    name: TOOL_MCP_ADD,
    label: "MCP Add",
    description:
      "Add an MCP server. Pass command (with optional args, env, cwd) for a " +
      "local stdio server or url (with optional headers) for a streamable " +
      "HTTP server, never both. A command server always goes into this " +
      "agent's own list and runs inside its machine. An HTTP server goes " +
      'into the shared list unless scope is "agent"; the shared list runs on ' +
      "the host and every agent and code-mode session uses it. The server is " +
      "connected and its tools listed before anything is saved, so a wrong " +
      "command fails here and changes nothing; verify=false saves without " +
      "that test. Its tools are discoverable with tool_search once it " +
      "connects.",
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
      const explicit = readScope(params.scope);
      let scope: McpScope;
      if (!hasAgent) {
        // Only one list exists here, and its servers run on the host, where
        // a command server is as normal as anywhere else.
        if (explicit === "agent") {
          throw new CoreError(
            "This conversation has no agent of its own, so there is no " +
              "agent list to add to. Omit scope to use the shared list.",
            "invalid",
          );
        }
        scope = "global";
      } else if (command !== undefined) {
        if (explicit === "global") {
          throw new CoreError(
            `MCP server "${name}" has a command, so it is a local process. A ` +
              "global entry runs on the host, where this conversation must " +
              'not start it. Use scope "agent" or omit scope.',
            "invalid",
          );
        }
        scope = "agent";
      } else {
        scope = explicit ?? "global";
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
      const existing =
        scope === "agent" ? admin.getAgentMcpInfo!() : admin.getAppMcpInfo();
      if (existing.servers.some((s) => s.name === name)) {
        throw new CoreError(
          `An MCP server named "${name}" is already in the ` +
            `${scope === "agent" ? "agent's own" : "shared"} list. Remove it ` +
            "first with mcp_remove, or choose another name.",
          "conflict",
        );
      }
      const verify = params.verify ?? true;
      let tested: McpTestResult | undefined;
      if (verify) {
        const probe =
          scope === "agent" ? admin.testAgentServer! : admin.testServer;
        tested = await probe(serializeMcpServers([server]));
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
      if (scope === "agent") admin.addAgentServer!(server);
      else admin.addAppServer(server);
      const lines = [
        `Added MCP server "${name}" (${server.type}) to ` +
          `${scope === "agent" ? "this agent's own list" : "the shared list"}. ` +
          `It runs ${scopeSummary(scope)}.`,
      ];
      if (tested?.ok === true) lines.push(testSummary(tested.tools));
      if (tested?.needsAuth === true) {
        lines.push(
          scope === "agent"
            ? "The server answered that a sign-in is required. An agent's own " +
                "list has no sign-in screen, so put the credential in headers."
            : "The server answered that a sign-in is required. Sign in from " +
                "Settings → MCP servers; until then it does not start.",
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
          scope,
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
      "Remove an MCP server by name (the names mcp_list reports). Omit scope " +
      "unless the same name is in both lists: the shared list is searched " +
      "first and, when only the agent's own list has it, that one is " +
      "removed. Removing from the shared list takes the server away from " +
      "every agent and every code-mode session; removing from the agent's " +
      "own list leaves the others untouched.",
    parameters: removeSchema,
    execute(_toolCallId, params): Promise<ToolResult> {
      const name = requireName(params.name);
      const explicit = readScope(params.scope);
      const agent = hasAgent ? admin.getAgentMcpInfo!() : undefined;
      const global = admin.getAppMcpInfo();
      const inGlobal = global.servers.some((s) => s.name === name);
      const inAgent = agent?.servers.some((s) => s.name === name) === true;
      let scope: McpScope;
      if (agent === undefined) {
        if (explicit === "agent") {
          throw new CoreError(
            "This conversation has no agent of its own, so there is no " +
              "agent list to remove from.",
            "invalid",
          );
        }
        scope = "global";
      } else if (!inGlobal && !inAgent) {
        throw new CoreError(
          `No MCP server named "${name}" is configured. Use mcp_list to see ` +
            "the shared list and this agent's own list.",
          "not_found",
        );
      } else if (inGlobal && inAgent && explicit === undefined) {
        throw new CoreError(
          `"${name}" is configured in both lists. Pass scope "global" or ` +
            `"agent" to say which one to remove.`,
          "invalid",
        );
      } else {
        scope = explicit ?? (inGlobal ? "global" : "agent");
      }
      if (scope === "agent") admin.removeAgentServer!(name);
      else admin.removeAppServer(name);
      const remaining =
        scope === "agent"
          ? (agent?.servers.length ?? 1) - 1
          : global.servers.length - 1;
      return Promise.resolve({
        content: [
          {
            type: "text",
            text:
              scope === "agent"
                ? `Removed MCP server "${name}" from this agent's own list. ` +
                  "Other agents and code mode are untouched."
                : `Removed MCP server "${name}" from the shared list. It is ` +
                  "gone from every agent and every code-mode session.",
          },
        ],
        details: { server: name, scope, remaining },
      });
    },
  };

  const list: Tool<typeof listSchema> = {
    name: TOOL_MCP_LIST,
    label: "MCP List",
    description: hasAgent
      ? "List the MCP servers of this conversation: the agent's own list, " +
        "whose servers run inside its machine, and the shared app-level " +
        "list, whose servers run on the host. Each row names its scope, type " +
        "and live status. A shared server with the same name as one of the " +
        `agent's own is overridden in this conversation.`
      : "List the MCP servers in the shared app-level list with their type, " +
        "enabled state and live status: connected and how many tools, failed " +
        "with the error, or needs a sign-in. These servers apply to every " +
        "workspace and every session.",
    parameters: listSchema,
    execute(): Promise<ToolResult> {
      const agent = hasAgent ? admin.getAgentMcpInfo!() : undefined;
      const global = admin.getAppMcpInfo();
      const own = agent?.servers ?? [];
      if (own.length === 0 && global.servers.length === 0) {
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: "No MCP servers are configured. Add one with mcp_add.",
            },
          ],
          details: { count: 0 },
        });
      }
      const ownNames = new Set(own.map((s) => s.name));
      const lines: string[] = [];
      if (agent !== undefined) {
        lines.push(
          "This agent's own list, which runs inside its machine and is seen " +
            "only by this agent:",
        );
        lines.push(
          ...(own.length === 0
            ? ["- none"]
            : own.map(
                (server) =>
                  `- ${server.name} (${server.type}): ${statusText(server)}`,
              )),
        );
        if (global.servers.length > 0) lines.push("");
      }
      if (global.servers.length > 0 || agent === undefined) {
        if (agent !== undefined) {
          lines.push(
            "The shared list, which runs on the host and is used by every " +
              "agent and every code-mode session:",
          );
        } else {
          lines.push("The shared list:");
        }
        lines.push(
          ...(global.servers.length === 0
            ? ["- none"]
            : global.servers.map(
                (server) =>
                  `- ${server.name} (${server.type}): ${statusText(server)}` +
                  (ownNames.has(server.name)
                    ? " [this conversation uses the agent's own server of " +
                      "the same name instead]"
                    : ""),
              )),
        );
      }
      return Promise.resolve({
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: own.length + global.servers.length,
          ...(agent !== undefined ? { agentCount: own.length } : {}),
        },
      });
    },
  };

  return [add, remove, list];
}
