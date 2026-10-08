import { existsSync } from "node:fs";
import { join } from "node:path";
import { CoreError, errorMessage } from "../errors.ts";
import { atomicWriteTextFileSync } from "../fs.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import {
  APP_MCP_SOURCE,
  loadMcpConfig,
  MCP_CONFIG_FILE,
  MCP_TEST_SOURCE,
  type McpConfig,
  type McpInfo,
  type McpServerConfig,
  parseMcpConfig,
} from "./config.ts";
import { APP_MCP_SETTINGS_KEY } from "../shared/mod.ts";
import type { McpServerStatus } from "./manager.ts";
import { probeMcpServer } from "./client.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import {
  connectionOAuthProvider,
  isMcpAuthRequired,
  McpOAuthStore,
} from "./oauth.ts";
import { McpAuthSessions, type McpAuthSnapshot } from "./oauth-session.ts";

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

/** The core surface this service needs (implemented by LumiscaCore). */
export interface McpServiceDeps {
  settings: SettingsRepo;
  listSessions(workspaceId?: string): SessionInfo[];
  /** Live MCP status of one open session's agent (null when not open). */
  agentMcpStatus(sessionId: string): McpServerStatus[] | null;
  requireWorkspace(id: string): Workspace;
  /** Guarded session mutation: refuses while any listed session is
   * streaming, applies the mutation, then rebuilds the agents. */
  applySessionChange(sessions: SessionInfo[], mutate: () => void): void;
  /** Rebuild the sessions' MCP attachments from scratch (fresh connections
   * and tool discovery), for a change no config write expresses — a
   * completed OAuth sign-in. Also refuses while streaming. */
  refreshSessionMcp(sessions: SessionInfo[]): void;
  /** Where OAuth grants are kept. Injected so the session connections read
   * the very store this service's sign-in writes (see mcp/oauth.ts);
   * created from `settings` when absent. */
  oauth?: McpOAuthStore;
}

/**
 * MCP configuration orchestration: the app-level (global) config in the
 * settings store plus each workspace's own `.mcp.json`, both validated on
 * write and reported to the settings UI with live per-session statuses.
 */
export class McpService {
  /** The OAuth grants of every configured HTTP server. Shared with the
   * session connections (see McpServiceDeps.oauth). */
  readonly oauth: McpOAuthStore;
  private readonly authSessions = new McpAuthSessions();

  constructor(private readonly deps: McpServiceDeps) {
    this.oauth = deps.oauth ?? new McpOAuthStore(deps.settings);
  }

  /** Build the McpInfo surface (config + live statuses) for a config. */
  private toMcpInfo(
    config: McpConfig,
    statuses: McpServerStatus[],
    exists: boolean,
  ): McpInfo {
    const statusMap = new Map(statuses.map((s) => [s.name, s]));
    return {
      filePath: config.filePath,
      exists,
      servers: config.servers.map((server) => {
        const status = statusMap.get(server.name);
        return {
          // The server's config fields come from the source of truth
          // (McpServerConfig) instead of being re-listed, so adding a field
          // there needs no change here.
          ...server,
          toolCount: status?.toolCount ?? 0,
          status: status?.status ?? "not_started",
          ...(status?.error !== undefined ? { error: status.error } : {}),
          ...(status?.needsAuth === true ? { needsAuth: true } : {}),
        };
      }),
    };
  }

  /** The app-level config from the settings file (empty when unset). */
  private loadAppMcpConfig(): McpConfig {
    const raw = this.deps.settings.get(APP_MCP_SETTINGS_KEY);
    if (raw === undefined) return this.emptyMcpConfig(APP_MCP_SOURCE);
    return parseMcpConfig(raw, APP_MCP_SOURCE);
  }

  private emptyMcpConfig(filePath: string): McpConfig {
    return { servers: [], filePath };
  }

  /** The app-level (global) MCP config with live statuses from every open
   * session. Stored in the settings file; applies to all workspaces. */
  getAppMcpInfo(): McpInfo {
    const exists = this.deps.settings.get(APP_MCP_SETTINGS_KEY) !== undefined;
    const config = this.loadAppMcpConfig();
    const statuses: McpServerStatus[] = [];
    for (const session of this.deps.listSessions()) {
      const sessionStatuses = this.deps.agentMcpStatus(session.id);
      if (sessionStatuses) statuses.push(...sessionStatuses);
    }
    return this.toMcpInfo(config, statuses, exists);
  }

  /** Replace the app-level MCP config (validating first), then rebuild
   * every open session so the new tools take effect. Throws `conflict`
   * while any session is streaming. */
  setAppMcpConfig(text: string): McpInfo {
    this.validateConfig(text, APP_MCP_SOURCE);
    const sessions = this.deps.listSessions();
    this.deps.applySessionChange(sessions, () => {
      this.deps.settings.set(APP_MCP_SETTINGS_KEY, text);
    });
    return this.getAppMcpInfo();
  }

  /** The workspace's own `.mcp.json` with live statuses from the
   * workspace's open sessions. Read fresh from disk each time, so external
   * edits are reflected here too. */
  getMcpInfo(workspaceId: string): McpInfo {
    const workspace = this.deps.requireWorkspace(workspaceId);
    const root = workspace.folders[0];
    if (!root) {
      return this.toMcpInfo(this.emptyMcpConfig(""), [], false);
    }
    let config: McpConfig;
    try {
      config = loadMcpConfig(root);
    } catch (error) {
      throw new CoreError(
        `MCP config error: ${errorMessage(error)}`,
        "invalid",
      );
    }
    const statuses: McpServerStatus[] = [];
    for (const session of this.deps.listSessions(workspaceId)) {
      const sessionStatuses = this.deps.agentMcpStatus(session.id);
      if (sessionStatuses) statuses.push(...sessionStatuses);
    }
    return this.toMcpInfo(
      config,
      statuses,
      existsSync(join(root, MCP_CONFIG_FILE)),
    );
  }

  /** Replace the workspace's `.mcp.json` (validating first), then rebuild
   * every session in the workspace so the new tools take effect. Throws
   * `conflict` while any session is streaming. */
  setMcpConfig(workspaceId: string, text: string): McpInfo {
    const workspace = this.deps.requireWorkspace(workspaceId);
    const root = workspace.folders[0];
    if (!root) throw new CoreError("Workspace has no folders", "invalid");
    const filePath = join(root, MCP_CONFIG_FILE);
    this.validateConfig(text, filePath);
    const sessions = this.deps.listSessions(workspaceId);
    this.deps.applySessionChange(sessions, () => {
      // Atomic write: a temp file + rename keeps the config valid even if
      // the process dies halfway.
      atomicWriteTextFileSync(filePath, text);
    });
    return this.getMcpInfo(workspaceId);
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
    const errors: string[] = [];
    let app: McpConfig;
    try {
      app = this.loadAppMcpConfig();
    } catch (error) {
      app = this.emptyMcpConfig(APP_MCP_SOURCE);
      errors.push(`App MCP config error: ${errorMessage(error)}`);
    }
    let workspaceConfig: McpConfig = this.emptyMcpConfig("");
    const root = workspace.folders[0];
    if (root) {
      try {
        workspaceConfig = loadMcpConfig(root);
      } catch (error) {
        errors.push(`MCP config error: ${errorMessage(error)}`);
      }
    }
    const byName = new Map(app.servers.map((s) => [s.name, s]));
    for (const server of workspaceConfig.servers) {
      byName.set(server.name, server);
    }
    for (const plugin of discoverPlugins(workspace.folders)) {
      for (const warning of plugin.warnings) {
        errors.push(`Plugin "${plugin.name}": ${warning}`);
      }
      // Plugin servers fill names no explicit config took (first plugin
      // wins among plugins).
      for (const server of plugin.mcpServers) {
        if (!byName.has(server.name)) byName.set(server.name, server);
      }
    }
    return {
      config: {
        servers: [...byName.values()],
        filePath: workspaceConfig.filePath || app.filePath,
      },
      errors,
    };
  }

  /** Parse-validate config text; throws CoreError("invalid") on failure. */
  private validateConfig(text: string, source: string): void {
    this.parseConfig(text, source);
  }

  /** Parse config text, mapping parse failures to CoreError("invalid")
   * (the API maps that kind to 400). */
  private parseConfig(text: string, source: string): McpConfig {
    try {
      return parseMcpConfig(text, source);
    } catch (error) {
      throw new CoreError(errorMessage(error), "invalid");
    }
  }

  /** Parse config text that describes exactly one server; throws
   * CoreError("invalid") when it does not. The settings UI's test and
   * sign-in flows both send a single server. */
  private parseSingleServer(text: string): McpServerConfig {
    const config = this.parseConfig(text, MCP_TEST_SOURCE);
    if (config.servers.length !== 1) {
      throw new CoreError(
        `MCP config needs exactly one server, got ${config.servers.length}`,
        "invalid",
      );
    }
    return config.servers[0]!;
  }

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
   * (see startAuth).
   */
  async testServer(text: string, timeoutMs?: number): Promise<McpTestResult> {
    const server = this.parseSingleServer(text);
    // A stored grant is what makes the probe connect *as* the signed-in
    // user (and refresh the token when it has expired). Without one the
    // plain 401 is the answer, and it carries needsAuth below.
    const authProvider = connectionOAuthProvider(this.oauth, server);
    try {
      const tools = await probeMcpServer(server, Deno.cwd(), timeoutMs, {
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
   * Start an interactive OAuth sign-in for one HTTP server. The flow runs
   * in the background; the resolved snapshot carries the authorization URL
   * the UI opens (or the reason the flow could not start).
   */
  async startAuth(
    text: string,
    redirectUri: string,
  ): Promise<McpAuthSnapshot> {
    const server = this.parseSingleServer(text);
    if (server.type !== "http" || server.url === undefined) {
      throw new CoreError(
        "OAuth sign-in needs an HTTP server (one with a url)",
        "invalid",
      );
    }
    return await this.authSessions.create(server, this.oauth, redirectUri)
      .started();
  }

  /** The current state of one sign-in, or undefined once it is forgotten. */
  getAuth(sessionId: string): McpAuthSnapshot | undefined {
    return this.authSessions.get(sessionId)?.snapshot();
  }

  /** Give up on a sign-in (the user cancelled it). */
  cancelAuth(sessionId: string): boolean {
    const session = this.authSessions.get(sessionId);
    if (session === undefined) return false;
    session.cancel();
    return true;
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
    const session = this.authSessions.getByState(input.state);
    if (session === undefined) return undefined;
    if (input.error !== undefined) {
      session.fail(`authorization failed: ${input.error}`);
    } else if (input.code !== undefined) {
      await session.complete(input.code);
    } else {
      session.fail(
        "the authorization response carried neither a code nor an error",
      );
    }
    const snapshot = session.snapshot();
    if (snapshot.status === "done") {
      this.refreshSessionsUsing(session.serverUrl);
    }
    return snapshot;
  }

  /** Reconnect the sessions whose merged config uses `serverUrl`, so the
   * grant this sign-in just stored reaches them without an unrelated config
   * edit (see McpServiceDeps.refreshSessionMcp). A session that is running
   * cannot be rebuilt; it picks the grant up at its next rebuild. */
  private refreshSessionsUsing(serverUrl: string): void {
    const sessions: SessionInfo[] = [];
    for (const session of this.deps.listSessions()) {
      let workspace: Workspace;
      try {
        workspace = this.deps.requireWorkspace(session.workspaceId);
      } catch {
        continue; // the workspace is gone: nothing to rebuild
      }
      const usesServer = this.loadMergedConfig(workspace).config.servers.some(
        (server) => server.url === serverUrl,
      );
      if (usesServer) sessions.push(session);
    }
    if (sessions.length === 0) return;
    try {
      this.deps.refreshSessionMcp(sessions);
    } catch {
      // Streaming sessions refuse the rebuild (conflict); the grant is
      // stored either way and applies the next time they are rebuilt.
    }
  }
}
