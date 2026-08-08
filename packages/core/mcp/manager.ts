import type { McpConfig, McpServerConfig } from "./config.ts";
import { formatContent, McpServerClient } from "./client.ts";

/** A tool exposed by an MCP server, ready to be wrapped as an AgentTool. */
export interface McpToolDef {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Status snapshot of one server, for the settings UI. */
export interface McpServerStatus {
  name: string;
  type: "stdio" | "http";
  enabled: boolean;
  /** Number of tools discovered (0 until the first successful listing). */
  toolCount: number;
  status: "ok" | "error";
  error?: string;
}

/**
 * Owns the lifecycle of one session's MCP servers: spawns stdio child
 * processes (or talks to HTTP servers) lazily via the official MCP SDK,
 * discovers their tools, and forwards tool calls. Failed or crashed
 * servers are reconnected on demand; `close()` tears everything down.
 */
export class McpManager {
  private readonly clients = new Map<string, McpServerClient>();
  private readonly errors = new Map<string, string>();
  private toolsCache: McpToolDef[] | null = null;
  private closed = false;

  constructor(
    private readonly config: McpConfig,
    private readonly cwd: string,
  ) {}

  private get enabledServers(): McpServerConfig[] {
    return this.config.servers.filter((s) => s.enabled);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("MCP manager is closed");
    }
  }

  private async getClient(
    server: McpServerConfig,
  ): Promise<McpServerClient> {
    this.assertOpen();
    let client = this.clients.get(server.name);
    if (client === undefined) {
      client = await McpServerClient.connect(server, this.cwd);
      this.clients.set(server.name, client);
    }
    return client;
  }

  private dropClient(name: string): void {
    const client = this.clients.get(name);
    this.clients.delete(name);
    if (client) void client.close();
  }

  /** Discover every tool of every enabled server. Per-server failures are
   * recorded and skipped — one broken server must not hide the others. */
  async listTools(): Promise<McpToolDef[]> {
    this.assertOpen();
    if (this.toolsCache) return this.toolsCache;
    const tools: McpToolDef[] = [];
    for (const server of this.enabledServers) {
      try {
        const client = await this.getClient(server);
        const infos = await client.listTools();
        for (const info of infos) {
          tools.push({
            server: server.name,
            name: info.name,
            description: info.description,
            inputSchema: info.inputSchema,
          });
        }
      } catch (error) {
        this.errors.set(
          server.name,
          error instanceof Error ? error.message : String(error),
        );
        this.dropClient(server.name); // allow a clean reconnect later
      }
    }
    this.toolsCache = tools;
    return tools;
  }

  /** Call a tool of a named server; the result is text-only. Crashed
   * servers are reconnected and the call retried once. */
  async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertOpen();
    const server = this.config.servers.find((s) => s.name === serverName);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }
    const client = await this.getClient(server);
    try {
      const content = await client.callTool(toolName, args, signal);
      return formatContent(content);
    } catch (error) {
      // Application-level errors (isError results) are final; transport or
      // server failures get one reconnect-and-retry attempt.
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("MCP tool ")) throw error;
      this.dropClient(server.name);
      const retried = await this.getClient(server);
      const content = await retried.callTool(toolName, args, signal);
      return formatContent(content);
    }
  }

  /** Current per-server state (never starts servers). */
  getStatus(): McpServerStatus[] {
    const toolCounts = new Map<string, number>();
    for (const tool of this.toolsCache ?? []) {
      toolCounts.set(tool.server, (toolCounts.get(tool.server) ?? 0) + 1);
    }
    return this.config.servers.map((server) => {
      const error = this.errors.get(server.name);
      return {
        name: server.name,
        type: server.type,
        enabled: server.enabled,
        toolCount: toolCounts.get(server.name) ?? 0,
        status: error !== undefined ? "error" : "ok",
        ...(error !== undefined ? { error } : {}),
      };
    });
  }

  /** Disconnect every server (kills stdio child processes). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
    this.toolsCache = null;
  }
}
