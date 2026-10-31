import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServerConfig } from "./config.ts";
import { resolveServerCwd } from "./config.ts";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Timeout of the settings UI's one-shot connection test (connect plus
 * tool listing). Generous on purpose: a first `npx -y …` run downloads
 * the server package before it answers. */
export const MCP_TEST_TIMEOUT_MS = 30_000;

/** What a caller may add to a connection. */
export interface McpTransportOptions {
  /** OAuth client of an HTTP server (see mcp/oauth.ts). Omitted when the
   * server has no stored grant: without one the 401 itself is the answer
   * ("sign in to this server"), where a provider would walk discovery and
   * registration only to end in an authorization nobody can finish. */
  authProvider?: OAuthClientProvider;
}

/** Build the SDK transport for a server config. Single home of the
 * stdio/HTTP selection so the session client, the sign-in flow and the
 * one-shot test probe connect exactly the same way. */
export function createMcpTransport(
  config: McpServerConfig,
  workspaceRoot: string,
  options: McpTransportOptions = {},
): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: config.env,
      cwd: resolveServerCwd(config, workspaceRoot),
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url!), {
    // Configured headers ride in `requestInit`: the transport builds its
    // request headers from `requestInit.headers`, and an unknown top-level
    // `headers` option is silently ignored (the SDK has no such option).
    requestInit: { headers: config.headers },
    ...(options.authProvider !== undefined
      ? { authProvider: options.authProvider }
      : {}),
  });
}

/** Normalize an SDK tool entry into this module's shape (shared by the
 * session client and the one-shot probe). */
function toToolInfo(
  tool: { name: string; description?: string; inputSchema?: unknown },
): McpToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
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

/** Upper bound for one tool call, in addition to the caller's abort. The
 * SDK's own default (60 s) applies to the request it sends; this bound
 * covers a server that keeps the request open, answers a progress-paged
 * call slowly, or never answers at all. A call that hits it fails as a
 * tool error rather than holding the agent's turn — the run cannot be
 * ended by a stop button while a stdio server is merely slow, and a
 * provider-side silence would otherwise look like the agent thinking. */
export const MCP_TOOL_CALL_TIMEOUT_MS = 120_000;
/** A tool call that did not answer within its time limit. Distinct from a
 * transport failure: reconnecting and re-sending would only hang again, so
 * the manager surfaces it instead of retrying (see McpManager.callTool). */
export class McpCallTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(
      `MCP tool ${toolName} did not answer within ${formatSeconds(timeoutMs)}`,
    );
    this.name = "McpCallTimeoutError";
  }
}

/** "120s", "0.3s": whole seconds stay whole, sub-second bounds keep one
 * decimal (a short bound injected by a test must not read as "0s"). */
function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/** Whether an SDK failure is its request timeout (ErrorCode.RequestTimeout,
 * -32001) rather than a broken transport. */
function isMcpRequestTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32001) return true;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && /request timed out/i.test(message);
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

  /** Spawn/connect and run the initialize handshake. `timeoutMs` bounds
   * the handshake itself (defaults to the SDK's own request timeout). */
  static async connect(
    config: McpServerConfig,
    workspaceRoot: string,
    timeoutMs?: number,
    options?: McpTransportOptions,
  ): Promise<McpServerClient> {
    const transport = createMcpTransport(config, workspaceRoot, options);
    const client = new Client({ name: "lumisca", version: "0.1" });
    await client.connect(transport, { timeout: timeoutMs });
    return new McpServerClient(client);
  }

  /** List the server's tools (pagination handled by the SDK). */
  async listTools(timeoutMs?: number): Promise<McpToolInfo[]> {
    const { tools } = await this.client.listTools(undefined, {
      timeout: timeoutMs,
    });
    return tools.map(toToolInfo);
  }

  /** Call a tool; rejects when the server reports isError or the call is
   * aborted. Returns the raw content blocks.
   *
   * The request carries the caller's abort AND {@link
   * MCP_TOOL_CALL_TIMEOUT_MS}: a server that never answers must fail the
   * call instead of holding the agent's turn open (the SDK's default
   * request timeout alone is a minute per attempt, and a hung server keeps
   * answering nothing). */
  async callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    timeoutMs: number = MCP_TOOL_CALL_TIMEOUT_MS,
  ): Promise<McpContentBlock[]> {
    // Note: the SDK signature is callTool(params, resultSchema?, options?);
    // options (signal/timeout) belong in the third position.
    let result: { isError?: boolean; content: unknown };
    try {
      result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { signal, timeout: timeoutMs },
      );
    } catch (error) {
      // The caller's abort is a stop, not a broken server: the SDK
      // reports a cancelled request with the same ErrorCode as its own
      // timeout, so the signal has to be consulted first (otherwise a stop
      // pressed mid-call reaches the agent as "the MCP server is broken"
      // and is not retried).
      if (signal?.aborted === true) throw error;
      // The SDK reports its request timeout as an McpError. Callers must be
      // able to tell "the server never answered" from "the connection
      // dropped": the first is not worth reconnecting and re-sending (the
      // server would just hang again), the second is.
      throw isMcpRequestTimeout(error)
        ? new McpCallTimeoutError(name, timeoutMs)
        : error;
    }
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

async function closeQuietly(close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch {
    // the server may already be gone
  }
}

/** Upper bound for waiting on a closed transport's close event. The SDK
 * waits up to 2s for a stdio child process before signalling it, so this
 * covers that path; only a transport that never started waits this long. */
const TRANSPORT_CLOSE_TIMEOUT_MS = 3_000;

/** Await `promise` for at most `ms`, leaving no timer behind when it wins. */
async function waitWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One-shot connection test of a single server: connect, list its tools,
 * then disconnect. Backs the settings UI's "test" button, which cannot
 * spawn processes itself. Errors propagate to the caller, which turns them
 * into a result surface.
 *
 * The transport is closed even when the handshake failed or timed out —
 * including `transport.close()` itself, because `client.close()` only
 * reaches a transport the client did connect to. The SDK closes a
 * transport whose handshake failed on its own but does not await that
 * (`void this.close()`), so the probe waits for the transport's close event
 * too: once it settles, a spawned server process is really gone.
 */
export async function probeMcpServer(
  config: McpServerConfig,
  workspaceRoot: string,
  timeoutMs: number = MCP_TEST_TIMEOUT_MS,
  options?: McpTransportOptions,
): Promise<McpToolInfo[]> {
  const transport = createMcpTransport(config, workspaceRoot, options);
  // Installed before connect(): Protocol.connect chains whatever handler
  // the transport already carries, so this survives its own wiring.
  const closed = new Promise<void>((resolve) => {
    const previous = transport.onclose;
    transport.onclose = () => {
      previous?.();
      resolve();
    };
  });
  const client = new Client({ name: "lumisca", version: "0.1" });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const { tools } = await client.listTools(undefined, {
      timeout: timeoutMs,
    });
    return tools.map(toToolInfo);
  } finally {
    await closeQuietly(() => client.close());
    await closeQuietly(() => transport.close());
    await waitWithin(closed, TRANSPORT_CLOSE_TIMEOUT_MS);
  }
}
