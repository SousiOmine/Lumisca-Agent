import { join, relative } from "node:path";
import type { Sandbox } from "../workspace/sandbox.ts";
import { errorMessage } from "../errors.ts";
import { TOOL_GLOB, TOOL_GREP } from "../shared.ts";
import {
  array,
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
} from "./schema.ts";
import { truncate, truncatedNote } from "./truncate.ts";

interface FsToolContext {
  sandbox: Sandbox;
}

/** Directories skipped while walking (on top of hidden entries). */
const DEFAULT_EXCLUDED_DIRS = new Set(["node_modules"]);

/** Files larger than this are skipped by grep (avoid loading huge files). */
const MAX_GREP_FILE_SIZE = 8 * 1024 * 1024;

/** Binary detection probes the first 8 KiB for a NUL byte. */
const BINARY_PROBE_BYTES = 8192;

/** One matched line, trimmed for display. */
function linePreview(line: string, max = 200): string {
  const trimmed = line.replace(/\s+$/g, "");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** Convert a glob pattern to a RegExp. Supports `**`, `*`, `?`, `{a,b}`.
 * A double-star segment matches zero or more directories, so a pattern like
 * `a` + `**` + slash + `b.ts` also matches `a/b.ts`. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const alts = glob
          .slice(i + 1, end)
          .split(",")
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        out += `(?:${alts})`;
        i = end + 1;
      } else {
        out += "\\{";
        i += 1;
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** A glob filter for paths relative to a search root. Patterns without a
 * separator match against the basename (ripgrep `-g` semantics), others
 * against the full relative path. */
class GlobFilter {
  private readonly matchers: Array<{ basenameOnly: boolean; re: RegExp }>;

  constructor(patterns: string[]) {
    this.matchers = patterns.map((p) => {
      const normalized = p.replace(/\\/g, "/");
      return {
        basenameOnly: !normalized.includes("/"),
        re: globToRegExp(normalized),
      };
    });
  }

  matches(relPath: string, isDir: boolean): boolean {
    const normalized = relPath.replace(/\\/g, "/");
    for (const { basenameOnly, re } of this.matchers) {
      const candidate = basenameOnly && !isDir
        ? normalized.slice(normalized.lastIndexOf("/") + 1)
        : normalized;
      if (re.test(candidate)) return true;
    }
    return false;
  }
}

/**
 * Recursively yield files under `root`. Hidden entries (`.`-prefixed) and
 * `node_modules` are skipped by default; symlinks are never followed.
 * `exclude` patterns prune directories as the walk descends.
 */
async function* walkFiles(
  root: string,
  options: { exclude?: GlobFilter; maxDepth?: number },
): AsyncGenerator<string> {
  const maxDepth = options.maxDepth ?? 32;
  async function* walk(dir: string, depth: number): AsyncGenerator<string> {
    if (depth > maxDepth) return;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return; // unreadable directory (permissions, race) — skip
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymlink) continue; // never follow symlinks
      if (entry.isDirectory) {
        if (entry.name.startsWith(".")) continue;
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) continue;
        const rel = relative(root, full);
        if (options.exclude?.matches(rel, true)) continue;
        yield* walk(full, depth + 1);
      } else if (entry.isFile) {
        if (entry.name.startsWith(".")) continue;
        const rel = relative(root, full);
        if (options.exclude?.matches(rel, false)) continue;
        yield full;
      }
    }
  }
  yield* walk(root, 0);
}

async function looksBinary(path: string): Promise<boolean> {
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(BINARY_PROBE_BYTES);
    const read = await file.read(buffer);
    if (read === null) return false;
    return buffer.subarray(0, read).includes(0);
  } finally {
    file.close();
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const grepSchema = object({
  pattern: string("Regular expression (or literal text) to search for"),
  path: optional(string(
    "File or directory to search; defaults to the whole workspace",
  )),
  literal: optional(
    boolean("Treat `pattern` as literal text instead of a regex"),
  ),
  include: optional(array(string(
    "Glob patterns of files to search (e.g. **/*.ts)",
  ))),
  exclude: optional(array(string("Glob patterns of paths to skip"))),
  case_sensitive: optional(boolean(
    "Case-sensitive matching (default: insensitive)",
  )),
  max_results: optional(integer(
    "Maximum matches to return (default 200, cap 1000)",
  )),
});
export function createGrepTool(
  ctx: FsToolContext,
): Tool<typeof grepSchema> {
  return {
    name: TOOL_GREP,
    label: "Grep",
    description:
      "Search file contents within the workspace using a regular expression. " +
      "Hidden files and node_modules are skipped unless `path` points at a specific file. " +
      "Matches are returned as path:line: text. Binary files and files larger than 8MB are skipped.",
    parameters: grepSchema,
    execute: async (_id, params) => {
      let re: RegExp;
      try {
        re = new RegExp(
          params.literal ? escapeRegExp(params.pattern) : params.pattern,
          params.case_sensitive ? "" : "i",
        );
      } catch (error) {
        throw new Error(
          `Invalid pattern: ${errorMessage(error)}`,
        );
      }

      const include = params.include?.length
        ? new GlobFilter(params.include)
        : undefined;
      const exclude = params.exclude?.length
        ? new GlobFilter(params.exclude)
        : undefined;
      const maxResults = Math.min(params.max_results ?? 200, 1000);

      const lines: string[] = [];
      let files = 0;
      if (params.path !== undefined) {
        const resolved = await resolveSearchRoot(ctx, params.path);
        const stat = await Deno.stat(resolved);
        if (stat.isFile) {
          // Explicitly targeted files bypass include/exclude filters.
          if (await grepFile(resolved, re, lines, maxResults)) files++;
        } else {
          files += await grepTree(
            resolved,
            re,
            include,
            exclude,
            lines,
            maxResults,
          );
        }
      } else {
        for (const root of ctx.sandbox.roots) {
          const stat = await Deno.stat(root).catch(() => null);
          if (stat === null) continue;
          if (stat.isFile) {
            if (await grepFile(root, re, lines, maxResults)) files++;
          } else {
            files += await grepTree(
              root,
              re,
              include,
              exclude,
              lines,
              maxResults,
            );
          }
          if (lines.length >= maxResults) break;
        }
      }

      const { text, truncated } = truncate(lines.join("\n"));
      const note = truncated ? truncatedNote("matches") : "";
      const capped = lines.length >= maxResults
        ? `\n[maximum of ${maxResults} matches reached]`
        : "";
      return {
        content: [{ type: "text", text: text + note + capped }],
        details: { matches: lines.length, files },
      };
    },
  };
}

/** Resolve a user-supplied search path inside the sandbox (throws on
 * sandbox escape or missing path). */
async function resolveSearchRoot(
  ctx: FsToolContext,
  requested: string,
): Promise<string> {
  const resolved = await ctx.sandbox.resolve(requested);
  if (!resolved.ok) throw new Error(resolved.reason);
  const stat = await Deno.stat(resolved.path).catch(() => null);
  if (stat === null) throw new Error(`Path does not exist: ${requested}`);
  return resolved.path;
}

/** Grep every file under a directory, honoring include/exclude filters. */
async function grepTree(
  root: string,
  re: RegExp,
  include: GlobFilter | undefined,
  exclude: GlobFilter | undefined,
  out: string[],
  maxResults: number,
): Promise<number> {
  let files = 0;
  for await (const file of walkFiles(root, { exclude })) {
    const rel = relative(root, file);
    if (include && !include.matches(rel, false)) continue;
    if (await grepFile(file, re, out, maxResults)) files++;
    if (out.length >= maxResults) break;
  }
  return files;
}

async function grepFile(
  path: string,
  re: RegExp,
  out: string[],
  maxResults: number,
): Promise<boolean> {
  const stat = await Deno.stat(path).catch(() => null);
  if (stat === null || !stat.isFile || stat.size > MAX_GREP_FILE_SIZE) {
    return false;
  }
  if (await looksBinary(path)) return false;

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return false;
  }
  const start = out.length;
  const split = text.split("\n");
  for (let i = 0; i < split.length && out.length < maxResults; i++) {
    if (re.test(split[i]!)) {
      out.push(`${path}:${i + 1}: ${linePreview(split[i]!)}`);
    }
  }
  return out.length > start;
}

const globSchema = object({
  pattern: string("Glob pattern relative to the search root, e.g. **/*.ts"),
  path: optional(
    string("Directory to search; defaults to the whole workspace"),
  ),
  exclude: optional(array(string("Glob patterns of paths to skip"))),
  max_results: optional(integer(
    "Maximum paths to return (default 500, cap 2000)",
  )),
});

export function createGlobTool(
  ctx: FsToolContext,
): Tool<typeof globSchema> {
  return {
    name: TOOL_GLOB,
    label: "Glob",
    description:
      "Find files by path pattern within the workspace. Supports `**`, `*`, `?` and `{a,b}`. " +
      "Hidden files and node_modules are skipped.",
    parameters: globSchema,
    execute: async (_id, params) => {
      let re: RegExp;
      try {
        re = globToRegExp(params.pattern.replace(/\\/g, "/"));
      } catch (error) {
        throw new Error(
          `Invalid pattern: ${errorMessage(error)}`,
        );
      }
      const exclude = params.exclude?.length
        ? new GlobFilter(params.exclude)
        : undefined;
      const maxResults = Math.min(params.max_results ?? 500, 2000);

      const found: string[] = [];
      if (params.path !== undefined) {
        const root = await resolveSearchRoot(ctx, params.path);
        const stat = await Deno.stat(root);
        if (stat.isFile) {
          if (re.test(root)) found.push(root);
        } else {
          for await (const file of walkFiles(root, { exclude })) {
            if (re.test(relative(root, file).replace(/\\/g, "/"))) {
              found.push(file);
              if (found.length >= maxResults) break;
            }
          }
        }
      } else {
        for (const root of ctx.sandbox.roots) {
          const stat = await Deno.stat(root).catch(() => null);
          if (stat === null) continue;
          if (stat.isFile) {
            if (re.test(root)) found.push(root);
          } else {
            for await (const file of walkFiles(root, { exclude })) {
              if (re.test(relative(root, file).replace(/\\/g, "/"))) {
                found.push(file);
                if (found.length >= maxResults) break;
              }
            }
          }
          if (found.length >= maxResults) break;
        }
      }

      const { text, truncated } = truncate(found.join("\n"));
      const note = truncated ? truncatedNote("paths") : "";
      const capped = found.length >= maxResults
        ? `\n[maximum of ${maxResults} paths reached]`
        : "";
      return {
        content: [{ type: "text", text: text + note + capped }],
        details: { count: found.length },
      };
    },
  };
}
