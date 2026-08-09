import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./config.ts";
import { resolveServerCwd } from "./config.ts";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A tool result content block (text or image). */
export interface McpContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Join MCP result content blocks into displayable text; images are
 * represented by a placeholder note (we only forward text to the model). */
export function formatContent(content: McpContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "image" || block.data !== undefined) {
      parts.push(`[image content: ${block.mimeType ?? "unknown"}]`);
    } else {
      parts.push(block.text ?? "");
    }
  }
  return parts.join("\n");
}

/** A tool call the server explicitly failed (isError result): final, not a
 * transport failure — callers must not retry it. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/**
 * One connected MCP server, backed by the official Model Context Protocol
 * TypeScript SDK. Stdio servers spawn a child process; HTTP servers use the
 * streamable HTTP transport (session ids, SSE and JSON handled by the SDK).
 */
export class McpServerClient {
  private readonly client: Client;
  private closed = false;

  private constructor(client: Client) {
    this.client = client;
  }

  /** Spawn/connect and run the initialize handshake. */
  static async connect(
    config: McpServerConfig,
    workspaceRoot: string,
  ): Promise<McpServerClient> {
    const transport = config.type === "stdio"
      ? new StdioClientTransport({
        command: config.command!,
        args: config.args,
        env: config.env,
        cwd: resolveServerCwd(config, workspaceRoot),
      })
      : new StreamableHTTPClientTransport(new URL(config.url!), {
        headers: config.headers,
      });
    const client = new Client({ name: "lumisca", version: "0.1" });
    await client.connect(transport);
    return new McpServerClient(client);
  }

  /** List the server's tools (pagination handled by the SDK). */
  async listTools(): Promise<McpToolInfo[]> {
    const { tools } = await this.client.listTools();
    return tools.map(
      (
        tool: { name: string; description?: string; inputSchema?: unknown },
      ) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }),
    );
  }

  /** Call a tool; rejects when the server reports isError or the call is
   * aborted. Returns the raw content blocks. */
  async callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<McpContentBlock[]> {
    // Note: the SDK signature is callTool(params, resultSchema?, options?);
    // options (signal/timeout) belong in the third position.
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { signal, timeout: timeoutMs },
    );
    if (result.isError === true) {
      throw new McpToolError(
        `MCP tool ${name} failed: ${
          formatContent(result.content as McpContentBlock[])
        }`,
      );
    }
    return result.content as McpContentBlock[];
  }

  /** Close the client and its transport (kills stdio child processes). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      // the server may already be gone
    }
  }
}
