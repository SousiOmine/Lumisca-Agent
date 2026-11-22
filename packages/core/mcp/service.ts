import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { CoreError } from "../errors.ts";
import type { McpServerConfig } from "../shared/mcp-config.ts";
import type { McpConfig, McpInfo } from "./config.ts";
import { McpOAuthStore } from "./oauth.ts";
import type { McpAuthSnapshot } from "./oauth-session.ts";
import { McpChecks, type McpTestResult } from "./service-checks.ts";
import { type McpConfigDeps, McpConfigStore } from "./service-config.ts";
import { McpConnections } from "./service-connections.ts";

export type { McpTestResult, McpTestTool } from "./service-checks.ts";

/** The core surface this service needs (implemented by LumiscaCore). */
export interface McpServiceDeps extends McpConfigDeps {
  /** Rebuild the sessions' MCP attachments from scratch (fresh connections
   * and tool discovery), for a change no config write expresses — a
   * completed OAuth sign-in. A streaming session is reconnected in place
   * rather than refused: the sign-in is what unblocks it. See
   * SessionPool.refreshMcp. */
  refreshSessionMcp(sessions: SessionInfo[]): void;
  /** Where OAuth grants are kept. Injected so the session connections read
   * the very store this service's sign-in writes (see mcp/oauth.ts);
   * created from `settings` when absent. */
  oauth?: McpOAuthStore;
}

/**
 * MCP configuration orchestration: the app-level (global) config in the
 * settings store plus each workspace's own `.mcp.json` (see
 * {@link McpConfigStore}), the OAuth sign-ins and the checks' connections
 * (see {@link McpConnections}), and the "test" / `watch` checks
 * ({@link McpChecks}). The stores are separate so a caller that only reads or
 * writes config never reaches the connections a check keeps open.
 */
export class McpService {
  /** The OAuth grants of every configured HTTP server. Shared with the
   * session connections (see McpServiceDeps.oauth). */
  readonly oauth: McpOAuthStore;
  private readonly config: McpConfigStore;
  private readonly connections: McpConnections;
  private readonly checks: McpChecks;

  constructor(private readonly deps: McpServiceDeps) {
    this.oauth = deps.oauth ?? new McpOAuthStore(deps.settings);
    this.config = new McpConfigStore(deps);
    this.connections = new McpConnections(this.oauth, () =>
      this.config.loadAppMcpConfig(),
    );
    this.checks = new McpChecks(this.config, this.connections, this.oauth);
  }

  /** The app-level (global) MCP config with live statuses from every open
   * session. Stored in the settings file; applies to all workspaces. */
  getAppMcpInfo(): McpInfo {
    return this.config.getAppMcpInfo();
  }

  /** Replace the app-level MCP config (validating first), then bring every
   * open session onto it so the new tools take effect: an idle session is
   * rebuilt, a streaming one has its servers reconnected in place (its run
   * keeps the tools it started with — see
   * SessionPool.applyMcpConfigChange). Never refuses: the config is stored
   * even while sessions run. */
  setAppMcpConfig(text: string): McpInfo {
    this.config.setAppMcpConfig(text);
    // The checks' own connections are not the sessions'
    // (see McpConnections): a server that just went away must not keep its
    // process alive, and the next check connects to what the config says now.
    this.connections.dropCheckManager();
    return this.getAppMcpInfo();
  }

  /** Add one server to the app-level config (the list Settings → MCP
   * servers shows) and bring every open session onto it. */
  addAppServer(server: McpServerConfig): McpInfo {
    return this.setAppMcpConfig(this.config.addAppServer(server));
  }

  /** Remove one server from the app-level config by name, and bring every
   * open session onto the new list (its tools stop being discoverable). */
  removeAppServer(name: string): McpInfo {
    return this.setAppMcpConfig(this.config.removeAppServer(name));
  }

  /** The workspace's own `.mcp.json` with live statuses from the
   * workspace's open sessions. Read fresh from disk each time, so external
   * edits are reflected here too. */
  getMcpInfo(workspaceId: string): McpInfo {
    return this.config.getMcpInfo(workspaceId);
  }

  /** Replace the workspace's `.mcp.json` (validating first), then bring the
   * workspace's open sessions onto it; see applyMcpConfigChange for how a
   * running one is handled. Never refuses: the file is written even while
   * sessions run. */
  setMcpConfig(workspaceId: string, text: string): McpInfo {
    return this.config.setMcpConfig(workspaceId, text);
  }

  /** Merge the app-level config with the workspace's `.mcp.json` and any
   * MCP servers contributed by agent plugins; workspace servers override
   * same-named app servers, and both override same-named plugin servers
   * (explicit user configuration wins over third-party plugins). Config
   * errors are collected instead of thrown so one broken source cannot
   * break session creation. */
  loadMergedConfig(workspace: Workspace): {
    config: McpConfig;
    errors: string[];
  } {
    return this.config.loadMergedConfig(workspace);
  }

  /** One-shot connection test of a single-server config (the settings UI's
   * "test" button): connect, list the tools, disconnect. Connection
   * failures come back as `{ ok: false, error }`; only the config text
   * itself is rejected with `invalid`. */
  testServer(text: string, timeoutMs?: number): Promise<McpTestResult> {
    return this.checks.testServer(text, timeoutMs);
  }

  /**
   * Start an interactive OAuth sign-in for one HTTP server. The flow runs
   * in the background; the resolved snapshot carries the authorization URL
   * the UI opens (or the reason the flow could not start).
   */
  async startAuth(text: string, redirectUri: string): Promise<McpAuthSnapshot> {
    const server = this.config.parseSingleServer(text);
    if (server.type !== "http" || server.url === undefined) {
      throw new CoreError(
        "OAuth sign-in needs an HTTP server (one with a url)",
        "invalid",
      );
    }
    return await this.connections.startAuth(server, redirectUri);
  }

  /** The current state of one sign-in, or undefined once it is forgotten. */
  getAuth(sessionId: string): McpAuthSnapshot | undefined {
    return this.connections.getAuth(sessionId);
  }

  /** Give up on a sign-in (the user cancelled it). */
  cancelAuth(sessionId: string): boolean {
    return this.connections.cancelAuth(sessionId);
  }

  /**
   * Finish the sign-in the browser came back to: `state` names the flow,
   * and either `code` (to exchange for tokens) or `error` (the
   * authorization server's refusal) says how it went. Undefined when no
   * sign-in waits on that state — an expired, cancelled or forged callback.
   */
  async completeAuth(input: {
    state: string;
    code?: string;
    error?: string;
  }): Promise<McpAuthSnapshot | undefined> {
    const snapshot = await this.connections.completeAuth(input);
    if (snapshot?.status === "done") {
      this.refreshSessionsUsing(snapshot.serverUrl);
    }
    return snapshot;
  }

  /** Whether a `watch` may call this tool, or why not (see
   * McpChecks.watchableToolProblem). */
  watchableToolProblem(server: string, tool: string): Promise<string | null> {
    return this.checks.watchableToolProblem(server, tool);
  }

  /** Call an MCP tool for a `watch` check, through the checks' own
   * connection (see McpConnections.managerForChecks). Refuses a tool that is
   * not watchable, so the rule cannot be bypassed by a routine saved before
   * the tool changed. */
  callToolForCheck(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.checks.callToolForCheck(server, tool, args, signal);
  }

  /** Close the connections the checks keep. The sessions' managers belong to
   * the pool, which closes them with their sessions. */
  close(): void {
    this.connections.close();
  }

  /** Reconnect the sessions whose merged config uses `serverUrl`, so the
   * grant this sign-in just stored reaches them without an unrelated config
   * edit (see McpServiceDeps.refreshSessionMcp). A running session is not
   * refused: the pool reconnects it in place, so the conversation the user
   * signed in for does not have to be restarted to reach the server. */
  private refreshSessionsUsing(serverUrl: string): void {
    const sessions: SessionInfo[] = [];
    for (const session of this.deps.listSessions()) {
      let workspace: Workspace;
      try {
        workspace = this.deps.requireWorkspace(session.workspaceId);
      } catch {
        continue; // the workspace is gone: nothing to rebuild
      }
      const usesServer = this.config
        .loadMergedConfig(workspace)
        .config.servers.some((server) => server.url === serverUrl);
      if (usesServer) sessions.push(session);
    }
    if (sessions.length === 0) return;
    // No catch: the pool reconnects a running session in place instead of
    // refusing it, so a throw here is a real failure (a closed workspace, a
    // broken config) and swallowing it would leave the user signed in with
    // no server that can answer.
    this.deps.refreshSessionMcp(sessions);
  }
}
