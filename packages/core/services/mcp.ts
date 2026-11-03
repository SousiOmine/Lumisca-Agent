import type { McpInfo } from "../mcp/config.ts";
import type { McpAuthSnapshot } from "../mcp/oauth-session.ts";
import type { McpService, McpTestResult } from "../mcp/service.ts";

/**
 * MCP configuration and sign-in: the app-level and per-workspace server
 * configs, the connection test the settings UI runs before saving, and the
 * interactive OAuth flow.
 *
 * McpService owns the merged config, the server processes and the grant
 * store; this class states the surface a route may use.
 */
export class McpConfigService {
  constructor(private readonly mcp: McpService) {}

  /** The app-level (global) MCP config with live statuses from every open
   * session. Stored in the settings file; applies to all workspaces. */
  getAppMcpInfo(): McpInfo {
    return this.mcp.getAppMcpInfo();
  }

  /** Replace the app-level MCP config (validating first), then rebuild
   * every open session so the new tools take effect. Throws `conflict`
   * while any session is streaming. */
  setAppMcpConfig(text: string): McpInfo {
    return this.mcp.setAppMcpConfig(text);
  }

  /** The workspace's own `.mcp.json` with live statuses from the
   * workspace's open sessions. Read fresh from disk each time, so external
   * edits are reflected here too. */
  getMcpInfo(workspaceId: string): McpInfo {
    return this.mcp.getMcpInfo(workspaceId);
  }

  /** Replace the workspace's `.mcp.json` (validating first), then rebuild
   * every session in the workspace so the new tools take effect. Throws
   * `conflict` while any session is streaming. */
  setMcpConfig(workspaceId: string, text: string): McpInfo {
    return this.mcp.setMcpConfig(workspaceId, text);
  }

  /** One-shot connection test of a single-server config, used by the
   * settings UI before it saves a new server. Reaching the server and
   * listing its tools happens here: the browser cannot spawn the stdio
   * child processes this app owns. */
  testMcpServer(text: string): Promise<McpTestResult> {
    return this.mcp.testServer(text);
  }

  /** Start an interactive OAuth sign-in for one HTTP MCP server (the
   * settings UI's "sign in" flow). `redirectUri` is where the browser is
   * sent back — a path of this server, so the callback reaches the process
   * that holds the PKCE verifier. Resolves once the flow either waits for
   * the browser (the snapshot carries the authorization URL) or fails to
   * start. */
  startMcpAuth(text: string, redirectUri: string): Promise<McpAuthSnapshot> {
    return this.mcp.startAuth(text, redirectUri);
  }

  /** Live state of one sign-in, for the UI's poll. */
  getMcpAuth(sessionId: string): McpAuthSnapshot | undefined {
    return this.mcp.getAuth(sessionId);
  }

  /** Abandon a sign-in. False once it is gone (already settled/expired). */
  cancelMcpAuth(sessionId: string): boolean {
    return this.mcp.cancelAuth(sessionId);
  }

  /** Finish the sign-in the browser came back to: `state` names the flow,
   * `code` is exchanged for tokens, an `error` records the authorization
   * server's refusal. Undefined when no sign-in waits on that state. */
  completeMcpAuth(
    input: { state: string; code?: string; error?: string },
  ): Promise<McpAuthSnapshot | undefined> {
    return this.mcp.completeAuth(input);
  }
}
