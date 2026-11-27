import { errorMessage } from "../errors.ts";
import { probeMcpServer } from "./client.ts";
import {
  connectionOAuthProvider,
  isMcpAuthRequired,
  type McpOAuthStore,
} from "./oauth.ts";
import type { McpConfigStore } from "./service-config.ts";
import type { McpConnections } from "./service-connections.ts";

/** What a server's tool name says about it when the server sends no
 * `readOnlyHint` (many send none). A watch calls a tool on a timer with
 * nobody watching, so it may only call one that reads: the rule is that a
 * name segment is one of these verbs (`GMAIL_FETCH_EMAILS`,
 * `SLACK_LIST_CHANNELS`). Anything else is refused, which is why the list
 * can be short — every write verb is refused by not being here
 * (`GMAIL_SEND_EMAIL`, `NOTION_CREATE_PAGE`). */
const READ_VERBS =
  /(^|_)(GET|LIST|FETCH|SEARCH|READ|FIND|QUERY|LOOKUP|VIEW)(_|$)/i;

/** One tool reported by the settings UI's one-shot connection test. */
export interface McpTestTool {
  name: string;
  description?: string;
}

/** Result of the settings UI's one-shot connection test. A server that
 * cannot be reached (bad command, timeout, HTTP error) is reported as
 * data, not as an API error: that is an expected outcome of pressing the
 * "test" button. Invalid config text still throws. */
export interface McpTestResult {
  ok: boolean;
  tools: McpTestTool[];
  error?: string;
  /** The server answered 401 (or asked for a sign-in the connection could
   * not complete): the UI offers the OAuth sign-in instead of reading this
   * as a broken server. */
  needsAuth?: boolean;
}

/**
 * The two places that ask a server a question before anyone uses it: the
 * settings UI's "test" button (connect, list, disconnect — reported as data,
 * because a server that is down is an answer to the button) and the gate a
 * `watch` check passes before it calls a tool on a timer.
 */
export class McpChecks {
  constructor(
    private readonly config: McpConfigStore,
    private readonly connections: McpConnections,
    private readonly oauth: McpOAuthStore,
  ) {}

  /**
   * One-shot connection test of a single-server config (the settings UI's
   * "test" button): connect, list the tools, disconnect. Connection
   * failures come back as `{ ok: false, error }`; only the config text
   * itself is rejected with `invalid`.
   *
   * The config is what the UI would save, so a disabled server is tested
   * too — the point of the button is to check a server before enabling it.
   * The probe runs in the server process's working directory, which is
   * where a relative `cwd` resolves (the settings UI edits the app-level
   * config, which has no workspace of its own).
   *
   * A server that answers 401 is reported as `needsAuth`, not as a
   * failure: the server is fine, it just wants the user to sign in first
   * (see McpService.startAuth).
   */
  async testServer(text: string, timeoutMs?: number): Promise<McpTestResult> {
    const server = this.config.parseSingleServer(text);
    // A stored grant is what makes the probe connect *as* the signed-in
    // user (and refresh the token when it has expired). Without one the
    // plain 401 is the answer, and it carries needsAuth below.
    const authProvider = connectionOAuthProvider(this.oauth, server);
    try {
      const tools = await probeMcpServer(server, process.cwd(), timeoutMs, {
        ...(authProvider !== undefined ? { authProvider } : {}),
      });
      return {
        ok: true,
        tools: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined
            ? { description: tool.description }
            : {}),
        })),
      };
    } catch (error) {
      return {
        ok: false,
        tools: [],
        error: errorMessage(error),
        ...(isMcpAuthRequired(error) ? { needsAuth: true } : {}),
      };
    }
  }

  /**
   * Whether a `watch` may call this tool, or why not.
   *
   * A check calls the tool on a timer, with no model in the loop, so a write
   * tool would act again and again on its own: the server's own
   * `readOnlyHint` is believed when it is sent, and a name whose verb is a
   * read is accepted otherwise (see READ_VERBS). Everything else is refused
   * — the check reports the message and does not fire.
   *
   * The tool is looked up through the checks' manager, so this also answers
   * "does the server exist and is it enabled, and does the tool exist": a
   * routine saved against a removed server says so instead of failing with
   * "unknown server" on every check.
   */
  async watchableToolProblem(
    server: string,
    tool: string,
  ): Promise<string | null> {
    const config = this.config.loadAppMcpConfig();
    const entry = config.servers.find((s) => s.name === server);
    if (entry === undefined) {
      return (
        `No MCP server named "${server}" is configured in the app's ` +
        "MCP settings"
      );
    }
    if (!entry.enabled) {
      return `The MCP server "${server}" is disabled`;
    }
    const manager = this.connections.managerForChecks();
    const def = (await manager.listTools()).find(
      (t) => t.server === server && t.name === tool,
    );
    if (def === undefined) {
      const status = manager.getStatus().find((s) => s.name === server);
      return status?.error !== undefined
        ? `The MCP server "${server}" could not be reached (${status.error})`
        : `The MCP server "${server}" has no tool named "${tool}"`;
    }
    if (def.annotations?.readOnlyHint === true) return null;
    if (def.annotations?.readOnlyHint === false) {
      return `"${tool}" may change things, so a watch cannot call it`;
    }
    return READ_VERBS.test(tool)
      ? null
      : `"${tool}" does not say it only reads. A watch runs with nobody ` +
          "watching, so it may call only a reading tool — one whose name has " +
          "GET, LIST, FETCH, SEARCH, READ, FIND, QUERY, LOOKUP or VIEW";
  }

  /** Call an MCP tool for a `watch` check, through the checks' own
   * connection (see McpConnections.managerForChecks). Refuses a tool that is
   * not watchable, so the rule cannot be bypassed by a routine saved before
   * the tool changed. */
  async callToolForCheck(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const problem = await this.watchableToolProblem(server, tool);
    if (problem !== null) throw new Error(problem);
    return await this.connections
      .managerForChecks()
      .callTool(server, tool, args, signal);
  }
}
