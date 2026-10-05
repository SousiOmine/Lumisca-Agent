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
  parseMcpConfig,
} from "./config.ts";
import { APP_MCP_SETTINGS_KEY } from "../shared/mod.ts";
import type { McpServerStatus } from "./manager.ts";
import { probeMcpServer } from "./client.ts";
import { discoverPlugins } from "../plugins/discover.ts";

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
}

/**
 * MCP configuration orchestration: the app-level (global) config in the
 * settings store plus each workspace's own `.mcp.json`, both validated on
 * write and reported to the settings UI with live per-session statuses.
 */
export class McpService {
  constructor(private readonly deps: McpServiceDeps) {}

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
   */
  async testServer(text: string, timeoutMs?: number): Promise<McpTestResult> {
    const config = this.parseConfig(text, MCP_TEST_SOURCE);
    if (config.servers.length !== 1) {
      throw new CoreError(
        `MCP test needs exactly one server, got ${config.servers.length}`,
        "invalid",
      );
    }
    const server = config.servers[0]!;
    try {
      const tools = await probeMcpServer(server, Deno.cwd(), timeoutMs);
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
      return { ok: false, tools: [], error: errorMessage(error) };
    }
  }
}
