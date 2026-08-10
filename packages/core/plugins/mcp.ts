import { join, normalize, sep } from "node:path";
import type { McpServerConfig } from "../mcp/config.ts";
import { errorMessage } from "../errors.ts";

/** Canonical identifier of the mcp.json schema this client implements
 * (Agent Plugins 1.0.0). */
export const MCP_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/** Env keys plugins may not set themselves: the client owns them and sets
 * them last, after the configured env overlay. */
const RESERVED_ENV_KEYS = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

/** `cwd` must start with "./", "${PLUGIN_ROOT}/" or "${PLUGIN_DATA}/" (the
 * canonical schema's pattern; containment is enforced separately). */
const CWD_PATTERN =
  /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

/** Top-level mcp.json keys (closed document: nothing else is allowed). */
const MCP_TOP_LEVEL_KEYS = new Set(["$schema", "mcpServers"]);

export interface PluginMcpResult {
  /** Validated servers, ready to be merged into the session MCP config. */
  servers: McpServerConfig[];
  /** Fatal top-level violation: the plugin's MCP component is disabled
   * (the plugin itself keeps loading). */
  fatal?: string;
  /** Non-fatal issues: invalid entries and unsupported transports. */
  warnings: string[];
}

/** Root directory holding per-plugin PLUGIN_DATA directories:
 * $XDG_DATA_HOME (or %LOCALAPPDATA% on Windows, else
 * ~/.local/share)/lumisca-agent/plugin-data. */
export function resolvePluginDataRoot(): string {
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME");
  const xdg = Deno.env.get("XDG_DATA_HOME");
  const localAppData = Deno.env.get("LOCALAPPDATA");
  const base = xdg ?? localAppData ??
    (home !== undefined ? join(home, ".local", "share") : undefined);
  if (base === undefined) return join(Deno.cwd(), ".lumisca-plugin-data");
  return join(base, "lumisca-agent", "plugin-data");
}

/**
 * Parse and validate a plugin's mcp.json (Agent Plugins 1.0.0, two-stage):
 * a top-level violation disables MCP for the whole plugin; an invalid
 * server entry disables only that entry. `sse` entries are validated but
 * skipped with a warning (legacy HTTP+SSE is optional for clients).
 */
export function parsePluginMcp(
  text: string,
  pluginRoot: string,
  pluginName: string,
  options: { pluginDataRoot?: string } = {},
): PluginMcpResult {
  const dataRoot = options.pluginDataRoot ?? resolvePluginDataRoot();
  const pluginData = join(dataRoot, pluginName);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      fatal: `mcp.json is not valid JSON: ${errorMessage(error)}`,
      servers: [],
      warnings: [],
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      fatal: "mcp.json must contain a JSON object",
      servers: [],
      warnings: [],
    };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.$schema !== MCP_SCHEMA_URL) {
    return {
      fatal:
        `mcp.json has an unsupported $schema; supported: ${MCP_SCHEMA_URL}`,
      servers: [],
      warnings: [],
    };
  }
  const mcpServers = obj.mcpServers;
  if (
    typeof mcpServers !== "object" || mcpServers === null ||
    Array.isArray(mcpServers)
  ) {
    return {
      fatal: 'mcp.json is missing the "mcpServers" object',
      servers: [],
      warnings: [],
    };
  }
  for (const key of Object.keys(obj)) {
    if (!MCP_TOP_LEVEL_KEYS.has(key)) {
      // The top-level document is closed; a stray key disables MCP.
      return {
        fatal: `mcp.json has an unknown top-level field "${key}"`,
        servers: [],
        warnings: [],
      };
    }
  }

  const warnings: string[] = [];
  const servers: McpServerConfig[] = [];
  let needsPluginData = false;

  for (
    const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)
  ) {
    if (!name.trim()) {
      warnings.push(`MCP server name must not be empty; entry skipped`);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      warnings.push(`MCP server "${name}" must be an object; entry skipped`);
      continue;
    }
    const cfg = entry as Record<string, unknown>;
    const type = cfg.type;
    if (type !== "stdio" && type !== "streamable-http" && type !== "sse") {
      warnings.push(
        `MCP server "${name}" has unknown transport "${
          String(type)
        }"; entry skipped`,
      );
      continue;
    }
    if (type === "stdio") {
      const server = parseStdioServer(name, cfg, pluginRoot, pluginData);
      if (server === undefined) {
        warnings.push(`MCP server "${name}" is invalid; entry skipped`);
      } else {
        servers.push(server);
        needsPluginData = true;
      }
    } else {
      const server = parseHttpServer(name, cfg);
      if (server === undefined) {
        warnings.push(`MCP server "${name}" is invalid; entry skipped`);
      } else if (type === "sse") {
        warnings.push(
          `MCP server "${name}" uses the "sse" transport, which Lumisca does not support; entry skipped`,
        );
      } else {
        servers.push(server);
      }
    }
  }

  if (needsPluginData) {
    // Dedicated writable PLUGIN_DATA dir, created before launch and kept
    // across plugin updates (keyed by plugin name only).
    Deno.mkdirSync(pluginData, { recursive: true });
  }
  return { servers, warnings };
}

function parseStdioServer(
  name: string,
  cfg: Record<string, unknown>,
  pluginRoot: string,
  pluginData: string,
): McpServerConfig | undefined {
  if (hasUnknownFields(cfg, ["type", "command", "args", "env", "cwd"])) {
    return undefined;
  }
  const command = cfg.command;
  if (typeof command !== "string" || command.length === 0) return undefined;
  const resolvedCommand = resolveCommand(command, pluginRoot);
  if (resolvedCommand === undefined) return undefined;

  const args = asStringArray(cfg.args);
  if (args === undefined) return undefined;
  const env = asEnv(cfg.env);
  if (env === undefined) return undefined;
  for (const key of Object.keys(env)) {
    if (RESERVED_ENV_KEYS.has(key)) return undefined; // client-owned keys
  }

  let cwd: string | undefined;
  if (cfg.cwd !== undefined && cfg.cwd !== null) {
    if (typeof cfg.cwd !== "string" || !CWD_PATTERN.test(cfg.cwd)) {
      return undefined;
    }
    cwd = expandPluginVars(cfg.cwd, pluginRoot, pluginData);
    if (cwd.startsWith("./")) {
      const resolved = resolveInside(pluginRoot, cwd.slice(2));
      if (resolved === undefined) return undefined;
      cwd = resolved;
    }
  }

  const expandedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    expandedEnv[key] = expandPluginVars(value, pluginRoot, pluginData);
  }
  // PLUGIN_ROOT / PLUGIN_DATA are client-controlled and set last, so a
  // configured env can never shadow them.
  expandedEnv.PLUGIN_ROOT = pluginRoot;
  expandedEnv.PLUGIN_DATA = pluginData;

  return {
    name,
    type: "stdio",
    command: resolvedCommand,
    args: args.map((a) => expandPluginVars(a, pluginRoot, pluginData)),
    env: expandedEnv,
    // Default cwd is the plugin root; resolveServerCwd keeps absolute
    // paths as-is.
    cwd: cwd ?? pluginRoot,
    headers: {},
    enabled: true,
  };
}

function parseHttpServer(
  name: string,
  cfg: Record<string, unknown>,
): McpServerConfig | undefined {
  if (hasUnknownFields(cfg, ["type", "url", "headers"])) return undefined;
  const url = cfg.url;
  if (typeof url !== "string" || url.length === 0) return undefined;
  const headers = asHeaders(cfg.headers);
  if (headers === undefined) return undefined;
  return {
    name,
    type: "http",
    args: [],
    env: {},
    url,
    headers,
    enabled: true,
  };
}

function hasUnknownFields(
  cfg: Record<string, unknown>,
  allowed: string[],
): boolean {
  return Object.keys(cfg).some((key) => !allowed.includes(key));
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return undefined;
  }
  return value as string[];
}

function asEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") return undefined;
    out[key] = entry;
  }
  return out;
}

function asHeaders(value: unknown): Record<string, string> | undefined {
  return asEnv(value);
}

/** Expand the two plugin placeholders (only in args, env values and cwd;
 * command, url and headers are never expanded). */
function expandPluginVars(value: string, root: string, data: string): string {
  return value
    .replaceAll("${PLUGIN_ROOT}", root)
    .replaceAll("${PLUGIN_DATA}", data);
}

/** A "./"-prefixed command resolves against the plugin root with
 * containment enforced; bare commands stay single executable tokens that
 * the platform search resolves. */
function resolveCommand(
  command: string,
  pluginRoot: string,
): string | undefined {
  if (!command.startsWith("./")) return command;
  const resolved = resolveInside(pluginRoot, command.slice(2));
  return resolved === undefined ? undefined : resolved;
}

/** Resolve a plugin-root-relative path with containment: lexical check
 * plus a filesystem-resolved (symlink-aware) check when the target
 * exists. Returns undefined when the path escapes the root. */
function resolveInside(root: string, relativePath: string): string | undefined {
  const resolved = normalize(join(root, relativePath));
  const rootNorm = normalize(root);
  if (resolved !== rootNorm && !resolved.startsWith(rootNorm + sep)) {
    return undefined;
  }
  return isWithinRealpath(root, resolved) ? resolved : undefined;
}

/** Filesystem-resolved containment: when both paths resolve, the real
 * path must stay inside the real root (symlink/junction escape guard).
 * Unresolvable targets (e.g. a command that does not exist yet) count as
 * inside; the lexical check above already ran. */
export function isWithinRealpath(root: string, path: string): boolean {
  try {
    const realRoot = Deno.realPathSync(root);
    const realPath = Deno.realPathSync(path);
    const cmp = (p: string) =>
      Deno.build.os === "windows" ? p.toLowerCase() : p;
    const r = cmp(realRoot);
    const p = cmp(realPath);
    return p === r || p.startsWith(r + sep);
  } catch {
    return true; // target may not exist yet (e.g. a command to build)
  }
}
