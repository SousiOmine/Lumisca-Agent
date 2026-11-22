import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { CoreError, errorMessage } from "../errors.ts";
import { atomicWriteTextFileSync } from "../fs.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import type { McpServerConfig } from "../shared/mcp-config.ts";
import { APP_MCP_SETTINGS_KEY, mcpServerEntry } from "../shared/mod.ts";
import {
  APP_MCP_SOURCE,
  loadMcpConfig,
  MCP_CONFIG_FILE,
  MCP_TEST_SOURCE,
  type McpConfig,
  type McpInfo,
  parseMcpConfig,
} from "./config.ts";
import type { McpServerStatus } from "./status.ts";

/** The core surface MCP configuration storage needs: the settings store the
 * app-level config lives in, the sessions whose live statuses a view
 * reports, and the pool call that brings those sessions onto a write. */
export interface McpConfigDeps {
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
}

/**
 * MCP configuration storage: the app-level (global) config in the settings
 * store plus each workspace's own `.mcp.json`, both validated on write and
 * reported to the settings UI with live per-session statuses.
 *
 * Storing a change and bringing the open sessions onto it is one step here,
 * because a config that reached the file but not the sessions would leave
 * the running conversations on a different server list than the next one.
 */
export class McpConfigStore {
  constructor(private readonly deps: McpConfigDeps) {}

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

  /** The live statuses of the given sessions, for one config's servers. */
  private statusesOf(workspaceId?: string): McpServerStatus[] {
    const statuses: McpServerStatus[] = [];
    for (const session of this.deps.listSessions(workspaceId)) {
      const sessionStatuses = this.deps.agentMcpStatus(session.id);
      if (sessionStatuses) statuses.push(...sessionStatuses);
    }
    return statuses;
  }

  /** The app-level config from the settings file (empty when unset). */
  loadAppMcpConfig(): McpConfig {
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
    return this.toMcpInfo(this.loadAppMcpConfig(), this.statusesOf(), exists);
  }

  /** Replace the app-level MCP config (validating first), then bring every
   * open session onto it so the new tools take effect: an idle session is
   * rebuilt, a streaming one has its servers reconnected in place (its run
   * keeps the tools it started with — see
   * SessionPool.applyMcpConfigChange). Never refuses: the config is stored
   * even while sessions run. */
  setAppMcpConfig(text: string): void {
    this.validateConfig(text, APP_MCP_SOURCE);
    const sessions = this.deps.listSessions();
    this.deps.applyMcpConfigChange(sessions, () => {
      this.deps.settings.set(APP_MCP_SETTINGS_KEY, text);
    });
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

  /** The config text of an app-level `mcpServers` object. The caller stores
   * it through setAppMcpConfig, so an edited server is validated and reaches
   * open sessions in the same turn. */
  private appServersText(servers: Record<string, unknown>): string {
    return JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
  }

  /**
   * Add one server to the app-level config (the list Settings → MCP
   * servers shows). Returns the config text to store through
   * setAppMcpConfig, which validates it and brings every open session onto
   * it.
   *
   * The stored document is edited as JSON instead of being re-serialized
   * from the parsed config: parsing expands `${VAR}` references, so a
   * round trip would write the expanded value of another server's secret
   * into the settings file.
   */
  addAppServer(server: McpServerConfig): string {
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
    return this.appServersText(servers);
  }

  /** Remove one server from the app-level config by name. Returns the text
   * to store, as addAppServer does; applying it stops the server's tools
   * being discoverable. */
  removeAppServer(name: string): string {
    const servers = this.appServersDocument();
    if (!Object.hasOwn(servers, name)) {
      throw new CoreError(
        `No MCP server named "${name}" is configured. Use mcp_list to see ` +
          "the servers in the app-level config.",
        "not_found",
      );
    }
    delete servers[name];
    return this.appServersText(servers);
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
    return this.toMcpInfo(
      config,
      this.statusesOf(workspaceId),
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
  parseSingleServer(text: string): McpServerConfig {
    const config = this.parseConfig(text, MCP_TEST_SOURCE);
    if (config.servers.length !== 1) {
      throw new CoreError(
        `MCP config needs exactly one server, got ${config.servers.length}`,
        "invalid",
      );
    }
    return config.servers[0]!;
  }
}
