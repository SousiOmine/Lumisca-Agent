import { basename, join } from "node:path";
import { findRepoRoot } from "../memory/agents-md.ts";
import { parseSkillFrontmatter } from "../skills/frontmatter.ts";
import type { SkillDef } from "../skills/discover.ts";
import type { McpServerConfig } from "../mcp/config.ts";
import { parsePluginManifest, type PluginManifest } from "./manifest.ts";
import { isWithinRealpath, parsePluginMcp } from "./mcp.ts";

/** Directory holding agent plugins (each immediate child directory is one
 * plugin root with a plugin.json manifest). Workspace and global
 * locations use the same `.agents` convention as skills. */
export const AGENTS_PLUGINS_DIR = ".agents/plugins";

/** A discovered plugin: manifest-valid plugins carry their loadable
 * components; rejected plugins (fatal manifest violation) surface only as
 * a warning so the failure can be reported. */
export interface PluginDef {
  /** The plugin's manifest name (unique across discovered plugins); for
   * rejected plugins the directory name. */
  name: string;
  /** Absolute path of the plugin root (the plugin's package boundary). */
  root: string;
  /** The validated manifest; undefined when the plugin was rejected. */
  manifest?: PluginManifest;
  /** Skills from the plugin's `skills/` (immediate children only). */
  skills: SkillDef[];
  /** MCP servers from the plugin's `mcp.json` (valid entries only). */
  mcpServers: McpServerConfig[];
  /** Non-fatal issues to report (invalid entries, skipped components). */
  warnings: string[];
}

export interface DiscoverPluginsOptions {
  /** Global plugin directories to scan instead of ~/.agents/plugins.
   * Used by tests to avoid touching the real home directory. */
  globalDirs?: string[];
  /** Root holding per-plugin PLUGIN_DATA directories (tests). */
  pluginDataRoot?: string;
}

/** Discover agent plugins for a set of workspace folders. For each folder
 * the repository root is located (via `.git`), then every `.agents/plugins`
 * directory from the root down to the folder is scanned (root first, like
 * skills). Global plugins (~/.agents/plugins) are appended after, so a
 * workspace plugin always shadows a global one of the same name. */
export function discoverPlugins(
  folders: string[],
  options: DiscoverPluginsOptions = {},
): PluginDef[] {
  const byName = new Map<string, PluginDef>();
  for (const folder of folders) {
    const root = findRepoRoot(folder);
    // Walk from the folder up to the root, then reverse so root-first.
    const chain: string[] = [folder];
    let current = folder;
    while (current !== root) {
      const parent = join(current, "..");
      if (parent === current) break;
      chain.push(parent);
      current = parent;
    }
    chain.reverse();
    for (const dir of chain) {
      scanPluginsDir(join(dir, AGENTS_PLUGINS_DIR), options, byName);
    }
  }
  for (const dir of resolveGlobalPluginDirs(options.globalDirs)) {
    scanPluginsDir(dir, options, byName);
  }
  return [...byName.values()];
}

function scanPluginsDir(
  dir: string,
  options: DiscoverPluginsOptions,
  byName: Map<string, PluginDef>,
): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return; // no plugins directory at this level
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const plugin = loadPlugin(join(dir, entry.name), options);
    if (plugin === undefined) continue;
    if (byName.has(plugin.name)) continue; // first discovery wins
    byName.set(plugin.name, plugin);
  }
}

/** Load one plugin root. Directories without a plugin.json are not
 * plugins (skipped silently); a fatal manifest violation rejects the
 * whole plugin; invalid components are isolated per the spec's failure
 * boundaries. */
function loadPlugin(
  root: string,
  options: DiscoverPluginsOptions,
): PluginDef | undefined {
  const pluginJsonPath = join(root, "plugin.json");
  const text = readIfExists(pluginJsonPath);
  if (text === undefined) return undefined;

  // Boundary 1: a plugin.json resolving outside the plugin root rejects
  // the plugin (fatal for the plugin).
  if (!isWithinRealpath(root, pluginJsonPath)) {
    return undefined; // symlink escape; treat as not a plugin
  }

  const result = parsePluginManifest(text, pluginJsonPath);
  if (result.fatal !== undefined || result.manifest === undefined) {
    // Fatal manifest violation: reject the whole plugin (no component
    // discovery, no execution); report the failure.
    return {
      name: basename(root),
      root,
      skills: [],
      mcpServers: [],
      warnings: [`Plugin rejected: ${result.fatal}`],
    };
  }
  const warnings = [...result.warnings];
  const skills = scanPluginSkills(root, warnings);
  const mcpServers = scanPluginMcp(
    root,
    result.manifest.name,
    options,
    warnings,
  );
  return {
    name: result.manifest.name,
    root,
    manifest: result.manifest,
    skills,
    mcpServers,
    warnings,
  };
}

/** Scan `skills/` (immediate child directories with a SKILL.md only —
 * never recursive). Boundary 2: a wrong filesystem kind at the location
 * disables the skill component type. Boundary 3: a SKILL.md escaping the
 * plugin root skips just that skill. */
function scanPluginSkills(root: string, warnings: string[]): SkillDef[] {
  const skillsDir = join(root, "skills");
  try {
    if (!Deno.statSync(skillsDir).isDirectory) {
      warnings.push(`"skills" is not a directory; skills disabled`);
      return [];
    }
  } catch {
    return []; // no skills component (valid absence)
  }
  const entries = [...Deno.readDirSync(skillsDir)];
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const skills: SkillDef[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const skillDir = join(skillsDir, entry.name);
    const skillPath = join(skillDir, "SKILL.md");
    if (!isWithinRealpath(root, skillPath)) {
      warnings.push(
        `Skill "${entry.name}": SKILL.md escapes the plugin root; skipped`,
      );
      continue;
    }
    const text = readIfExists(skillPath);
    if (text === undefined) continue;
    const meta = parseSkillFrontmatter(text);
    if (meta === undefined) continue;
    // The frontmatter name must match the directory name (same rule as
    // workspace skills); anything else is not a loadable skill.
    if (meta.name !== entry.name) continue;
    skills.push({
      name: meta.name,
      description: meta.description,
      path: skillPath,
      dir: skillDir,
      source: "plugin",
    });
  }
  return skills;
}

/** Load `mcp.json`. Boundary 2: a wrong filesystem kind at the location
 * disables MCP for the plugin. A top-level document violation disables
 * MCP for the plugin; invalid entries are skipped individually. */
function scanPluginMcp(
  root: string,
  pluginName: string,
  options: DiscoverPluginsOptions,
  warnings: string[],
): McpServerConfig[] {
  const mcpJsonPath = join(root, "mcp.json");
  let text: string;
  try {
    if (!Deno.statSync(mcpJsonPath).isFile) {
      warnings.push(`"mcp.json" is not a file; MCP disabled`);
      return [];
    }
    text = Deno.readTextFileSync(mcpJsonPath);
  } catch {
    return []; // no mcp.json (valid absence)
  }
  const result = parsePluginMcp(text, root, pluginName, {
    pluginDataRoot: options.pluginDataRoot,
  });
  if (result.fatal !== undefined) {
    warnings.push(`MCP disabled: ${result.fatal}`);
    return [];
  }
  warnings.push(...result.warnings);
  return result.servers;
}

function resolveGlobalPluginDirs(injected?: string[]): string[] {
  if (injected !== undefined) return injected;
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME");
  if (home === undefined || home === "") return [];
  return [join(home, AGENTS_PLUGINS_DIR)];
}

function readIfExists(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return undefined;
  }
}
