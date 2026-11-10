import { existsSync } from "node:fs";
import { join } from "node:path";
import { CoreError, errorMessage } from "../errors.ts";
import { atomicWriteTextFileSync } from "../fs.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
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
import { APP_MCP_SETTINGS_KEY, mcpServerEntry } from "../shared/mod.ts";
import type { McpServerStatus } from "./status.ts";
import { probeMcpServer } from "./client.ts";
import { McpManager } from "./manager.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import {
  connectionOAuthProvider,
  isMcpAuthRequired,
  McpOAuthStore,
} from "./oauth.ts";
import { McpAuthSessions, type McpAuthSnapshot } from "./oauth-session.ts";

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

/** The core surface this service needs (implemented by LumiscaCore). */
export interface McpServiceDeps {
  settings: SettingsRepo;
  listSessions(workspaceId?: string): SessionInfo[];
  /** Live MCP status of one open session's agent (null when not open). */
  agentMcpStatus(sessionId: string): McpServerStatus[] | null;
  requireWorkspace(id: string): Workspace;
  /** Apply an MCP config change to the listed sessions: the mutation always
   * runs (a config must never be lost to a running session), and each open
   * session is brought onto the new config — an idle one by a rebuild, a
   * streaming one by reconnecting its MCP servers in place. See
   * SessionPool.applyMcpConfigChange. */
  applyMcpConfigChange(sessions: SessionInfo[], mutate: () => void): void;
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
 * settings store plus each workspace's own `.mcp.json`, both validated on
 * write and reported to the settings UI with live per-session statuses.
 */
export class McpService {
  /** The OAuth grants of every configured HTTP server. Shared with the
   * session connections (see McpServiceDeps.oauth). */
  readonly oauth: McpOAuthStore;
  private readonly authSessions = new McpAuthSessions();
  /** The connections a `watch` check calls through, and the config text they
   * were built from. Separate from any session's manager: a check runs
   * whether or not a client has the conversation open, and a headless server
   * has no session at all. */
  private checkManager: McpManager | null = null;
  private checkManagerKey: string | null = null;

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

  /** Replace the app-level MCP config (validating first), then bring every
   * open session onto it so the new tools take effect: an idle session is
   * rebuilt, a streaming one has its servers reconnected in place (its run
   * keeps the tools it started with — see
   * SessionPool.applyMcpConfigChange). Never refuses: the config is stored
   * even while sessions run. */
  setAppMcpConfig(text: string): McpInfo {
    this.validateConfig(text, APP_MCP_SOURCE);
    const sessions = this.deps.listSessions();
    this.deps.applyMcpConfigChange(sessions, () => {
      this.deps.settings.set(APP_MCP_SETTINGS_KEY, text);
    });
    // The checks' own connections are not the sessions' (see checkManager):
    // a server that just went away must not keep its process alive, and the
    // next check connects to what the config says now.
    this.dropCheckManager();
    return this.getAppMcpInfo();
  }

  /** The app-level `mcpServers` object as stored, validated first so a
   * broken stored config fails with the reader's message instead of a bare
   * JSON syntax error. */
  private appServersDocument(): Record<string, unknown> {
    const raw = this.deps.settings.get(APP_MCP_SETTINGS_KEY);
    if (raw === undefined) return {};
    this.validateConfig(raw, APP_MCP_SOURCE);
    const document = JSON.parse(raw) as {
      mcpServers: Record<string, unknown>;
    };
    return document.mcpServers;
  }

  /** Write the app-level `mcpServers` object: setAppMcpConfig validates and
   * applies it, so an added server is stored and reaches open sessions in
   * the same turn. */
  private writeAppServers(servers: Record<string, unknown>): McpInfo {
    return this.setAppMcpConfig(
      JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
    );
  }

  /**
   * Add one server to the app-level config (the list Settings → MCP
   * servers shows) and bring every open session onto it.
   *
   * The stored document is edited as JSON instead of being re-serialized
   * from the parsed config: parsing expands `${VAR}` references, so a
   * round trip would write the expanded value of another server's secret
   * into the settings file.
   */
  addAppServer(server: McpServerConfig): McpInfo {
    const servers = this.appServersDocument();
    if (Object.hasOwn(servers, server.name)) {
      throw new CoreError(
        `An MCP server named "${server.name}" is already configured. ` +
          "Remove it first with mcp_remove, or choose another name.",
        "conflict",
      );
    }
    // defineProperty rather than an assignment: a server literally named
    // "__proto__" must become an entry, not set the document's prototype
    // (which would drop it from the written JSON).
    Object.defineProperty(servers, server.name, {
      value: mcpServerEntry(server),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return this.writeAppServers(servers);
  }

  /** Remove one server from the app-level config by name, and bring every
   * open session onto the new list (its tools stop being discoverable). */
  removeAppServer(name: string): McpInfo {
    const servers = this.appServersDocument();
    if (!Object.hasOwn(servers, name)) {
      throw new CoreError(
        `No MCP server named "${name}" is configured. Use mcp_list to see ` +
          "the servers in the app-level config.",
        "not_found",
      );
    }
    delete servers[name];
    return this.writeAppServers(servers);
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

  /** Replace the workspace's `.mcp.json` (validating first), then bring the
   * workspace's open sessions onto it; see applyMcpConfigChange for how a
   * running one is handled. Never refuses: the file is written even while
   * sessions run. */
  setMcpConfig(workspaceId: string, text: string): McpInfo {
    const workspace = this.deps.requireWorkspace(workspaceId);
    const root = workspace.folders[0];
    if (!root) throw new CoreError("Workspace has no folders", "invalid");
    const filePath = join(root, MCP_CONFIG_FILE);
    this.validateConfig(text, filePath);
    const sessions = this.deps.listSessions(workspaceId);
    this.deps.applyMcpConfigChange(sessions, () => {
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
    const config = this.loadAppMcpConfig();
    const entry = config.servers.find((s) => s.name === server);
    if (entry === undefined) {
      return `No MCP server named "${server}" is configured in the app's ` +
        "MCP settings";
    }
    if (!entry.enabled) {
      return `The MCP server "${server}" is disabled`;
    }
    const manager = this.managerForChecks();
    const def = (await manager.listTools()).find((t) =>
      t.server === server && t.name === tool
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
   * connection (see checkManager). Refuses a tool that is not watchable, so
   * the rule cannot be bypassed by a routine saved before the tool changed. */
  async callToolForCheck(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const problem = await this.watchableToolProblem(server, tool);
    if (problem !== null) throw new Error(problem);
    return await this.managerForChecks().callTool(
      server,
      tool,
      args,
      signal,
    );
  }

  /** Close the connections the checks keep. The sessions' managers belong to
   * the pool, which closes them with their sessions. */
  close(): void {
    this.dropCheckManager();
  }

  /** The manager the checks call through, built from the app-level config
   * (the only config a stella routine can see: it has no workspace, and a
   * plugin's servers come and go with the plugin). Rebuilt when the config
   * changed, so a check never calls a server the user just removed. */
  private managerForChecks(): McpManager {
    const config = this.loadAppMcpConfig();
    const key = JSON.stringify(config.servers);
    const existing = this.checkManager;
    if (existing !== null && this.checkManagerKey === key) return existing;
    this.dropCheckManager();
    const manager = new McpManager(config, Deno.cwd(), this.oauth);
    this.checkManager = manager;
    this.checkManagerKey = key;
    return manager;
  }

  private dropCheckManager(): void {
    const manager = this.checkManager;
    this.checkManager = null;
    this.checkManagerKey = null;
    if (manager !== null) void manager.close();
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
      const usesServer = this.loadMergedConfig(workspace).config.servers.some(
        (server) => server.url === serverUrl,
      );
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
