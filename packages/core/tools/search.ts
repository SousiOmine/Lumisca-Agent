import { relative } from "node:path";
import type { Sandbox } from "../workspace/sandbox.ts";
import { walkEntries } from "../workspace/walk.ts";
import { errorMessage } from "../errors.ts";
import { TOOL_GLOB, TOOL_GREP } from "../shared.ts";
import { GitignoreMatcher, globToRegExp } from "./gitignore.ts";
import {
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
} from "./schema.ts";
import { truncate, truncatedNote } from "./truncate.ts";
import { requireResolved } from "./resolve.ts";

/** Re-exported so existing importers (tests) keep importing from here. */
export { globToRegExp };

interface FsToolContext {
  sandbox: Sandbox;
}

/** Files larger than this are skipped by grep (avoid loading huge files). */
const MAX_GREP_FILE_SIZE = 8 * 1024 * 1024;

/** Binary detection probes the first 8 KiB for a NUL byte. */
const BINARY_PROBE_BYTES = 8192;

/** One matched line, trimmed for display. */
function linePreview(line: string, max = 200): string {
  const trimmed = line.replace(/\s+$/g, "");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Recursively yield files under `root` (see walkEntries for the walk
 * policy: hidden skipped by default, symlinks never followed, gitignore
 * pruning). With `skipHidden` (default) hidden entries are skipped.
 */
async function* walkFiles(
  root: string,
  options: {
    skipHidden?: boolean;
    gitignore?: GitignoreMatcher;
    maxDepth?: number;
  } = {},
): AsyncGenerator<string> {
  for await (
    const entry of walkEntries(root, {
      skipHidden: options.skipHidden,
      gitignore: options.gitignore,
      maxDepth: options.maxDepth,
    })
  ) {
    if (!entry.isDir) yield entry.path;
  }
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

const grepSchema = object({
  pattern: string("Regular expression to search for"),
  path: optional(string(
    "File or directory to search; defaults to the whole workspace",
  )),
  case: optional(boolean(
    "Case-sensitive matching (default: insensitive)",
  )),
  gitignore: optional(boolean(
    "Skip files matched by .gitignore (default: true)",
  )),
  max_results: optional(integer(
    "Maximum matches to return (default 200, cap 1000)",
  )),
});
/** Model-supplied patterns are applied per line without a timeout; a
 * length cap keeps catastrophic-backtracking (ReDoS) patterns bounded. */
const MAX_GREP_PATTERN_CHARS = 256;
/** Model-supplied glob patterns are compiled to regexes; cap the length so
 * a pathological pattern cannot build a giant regex. */
const MAX_GLOB_PATTERN_CHARS = 1024;

export function createGrepTool(
  ctx: FsToolContext,
): Tool<typeof grepSchema> {
  return {
    name: TOOL_GREP,
    label: "Grep",
    description:
      "Search file contents within the workspace using a regular expression. " +
      "Files matched by .gitignore are skipped; set `gitignore` to false to " +
      "search them too. Matches are returned as path:line: text. Binary " +
      "files and files larger than 8MB are skipped.",
    parameters: grepSchema,
    execute: async (_id, params) => {
      if (params.pattern.length > MAX_GREP_PATTERN_CHARS) {
        throw new Error(
          `pattern is too long (max ${MAX_GREP_PATTERN_CHARS} chars)`,
        );
      }
      let re: RegExp;
      try {
        re = new RegExp(params.pattern, params.case ? "" : "i");
      } catch (error) {
        throw new Error(
          `Invalid pattern: ${errorMessage(error)}`,
        );
      }

      const gitignore = params.gitignore === false
        ? undefined
        : await GitignoreMatcher.load(ctx.sandbox.roots);
      const maxResults = Math.min(params.max_results ?? 200, 1000);

      const lines: string[] = [];
      let files = 0;
      if (params.path !== undefined) {
        const resolved = await resolveSearchRoot(ctx, params.path);
        const stat = await Deno.stat(resolved);
        if (stat.isFile) {
          // Explicitly targeted files bypass gitignore filtering.
          if (await grepFile(resolved, re, lines, maxResults)) files++;
        } else {
          files += await grepTree(resolved, re, gitignore, lines, maxResults);
        }
      } else {
        for (const root of ctx.sandbox.roots) {
          const stat = await Deno.stat(root).catch(() => null);
          if (stat === null) continue;
          if (stat.isFile) {
            if (await grepFile(root, re, lines, maxResults)) files++;
          } else {
            files += await grepTree(root, re, gitignore, lines, maxResults);
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
  const path = await requireResolved(ctx.sandbox, requested);
  const stat = await Deno.stat(path).catch(() => null);
  if (stat === null) throw new Error(`Path does not exist: ${requested}`);
  return path;
}

/** Grep every file under a directory, honoring gitignore filtering (hidden
 * files and node_modules are searched too). */
async function grepTree(
  root: string,
  re: RegExp,
  gitignore: GitignoreMatcher | undefined,
  out: string[],
  maxResults: number,
): Promise<number> {
  let files = 0;
  for await (const file of walkFiles(root, { skipHidden: false, gitignore })) {
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
  gitignore: optional(boolean(
    "Skip files matched by .gitignore (default: true)",
  )),
  hidden: optional(boolean(
    "Search hidden files (dot-prefixed, default: true)",
  )),
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
      "Files matched by .gitignore are skipped; set `gitignore` to false to " +
      "search them too. Hidden files are searched; set `hidden` to false to " +
      "skip them.",
    parameters: globSchema,
    execute: async (_id, params) => {
      if (params.pattern.length > MAX_GLOB_PATTERN_CHARS) {
        throw new Error(
          `pattern is too long (max ${MAX_GLOB_PATTERN_CHARS} chars)`,
        );
      }
      let re: RegExp;
      try {
        re = globToRegExp(params.pattern.replace(/\\/g, "/"));
      } catch (error) {
        throw new Error(
          `Invalid pattern: ${errorMessage(error)}`,
        );
      }
      const gitignore = params.gitignore === false
        ? undefined
        : await GitignoreMatcher.load(ctx.sandbox.roots);
      const maxResults = Math.min(params.max_results ?? 500, 2000);
      const walk = (root: string) =>
        walkFiles(root, {
          skipHidden: params.hidden === false,
          gitignore,
        });

      const found: string[] = [];
      if (params.path !== undefined) {
        const root = await resolveSearchRoot(ctx, params.path);
        const stat = await Deno.stat(root);
        if (stat.isFile) {
          if (re.test(root)) found.push(root);
        } else {
          for await (const file of walk(root)) {
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
            for await (const file of walk(root)) {
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
