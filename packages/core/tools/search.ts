import { relative } from "node:path";
import type { Sandbox } from "../workspace/sandbox.ts";
import { BUILD_ARTIFACT_DIRS, walkEntries } from "../workspace/walk.ts";
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

/** Files are read in batches of this many, overlapping I/O without
 * unbounded memory use. */
const GREP_CONCURRENCY = 16;

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
      // VCS metadata and build-output trees (e.g. .git, dist, target) are
      // never worth searching; pruning them before reading saves a lot of
      // file opens on real repositories.
      excludedDirs: BUILD_ARTIFACT_DIRS,
    })
  ) {
    if (!entry.isDir) yield entry.path;
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
      "files, files larger than 8MB, and build-artifact/VCS directories " +
      "(.git, dist, build, target, ...) are skipped.",
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
          const hits = await grepFileLines(resolved, re, maxResults);
          if (hits.length > 0) files++;
          appendLines(lines, hits, maxResults);
        } else {
          files += await grepTree(resolved, re, gitignore, lines, maxResults);
        }
      } else {
        for (const root of ctx.sandbox.roots) {
          const stat = await Deno.stat(root).catch(() => null);
          if (stat === null) continue;
          if (stat.isFile) {
            const hits = await grepFileLines(root, re, maxResults);
            if (hits.length > 0) files++;
            appendLines(lines, hits, maxResults);
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
 * files and node_modules are searched too). Files are read in concurrent
 * batches; matches are appended in walk order so the output stays
 * deterministic. Returns the number of files with at least one match. */
async function grepTree(
  root: string,
  re: RegExp,
  gitignore: GitignoreMatcher | undefined,
  out: string[],
  maxResults: number,
): Promise<number> {
  let files = 0;
  let batch: string[] = [];
  for await (const file of walkFiles(root, { skipHidden: false, gitignore })) {
    batch.push(file);
    if (batch.length >= GREP_CONCURRENCY) {
      files += await grepBatch(batch, re, out, maxResults);
      batch = [];
      if (out.length >= maxResults) break;
    }
  }
  if (batch.length > 0 && out.length < maxResults) {
    files += await grepBatch(batch, re, out, maxResults);
  }
  return files;
}

/** Grep a batch of files concurrently and append their matches to `out`
 * in the given (walk) order. Returns the number of files with matches. */
async function grepBatch(
  batch: string[],
  re: RegExp,
  out: string[],
  maxResults: number,
): Promise<number> {
  const results = await Promise.all(
    batch.map((path) => grepFileLines(path, re, maxResults)),
  );
  let files = 0;
  for (const hits of results) {
    if (!hits.length) continue;
    files++;
    appendLines(out, hits, maxResults);
    if (out.length >= maxResults) break;
  }
  return files;
}

/** Append `hits` to `out`, never exceeding `maxResults`. */
function appendLines(out: string[], hits: string[], maxResults: number) {
  for (const line of hits) {
    if (out.length >= maxResults) break;
    out.push(line);
  }
}

/** Grep a single file; returns its matching lines (`path:line: text`).
 * Returns an empty array when the file is skipped: missing, not a regular
 * file, larger than MAX_GREP_FILE_SIZE, binary (NUL byte anywhere in its
 * decoded content) or unreadable. */
async function grepFileLines(
  path: string,
  re: RegExp,
  maxResults: number,
): Promise<string[]> {
  const stat = await Deno.stat(path).catch(() => null);
  if (stat === null || !stat.isFile || stat.size > MAX_GREP_FILE_SIZE) {
    return [];
  }
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return [];
  }
  // Reading the file once also serves binary detection: NUL bytes survive
  // the UTF-8 decode, so no separate probe open is needed.
  if (text.includes("\u0000")) return [];
  const hits: string[] = [];
  const split = text.split("\n");
  for (let i = 0; i < split.length && hits.length < maxResults; i++) {
    if (re.test(split[i]!)) {
      hits.push(`${path}:${i + 1}: ${linePreview(split[i]!)}`);
    }
  }
  return hits;
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
      "skip them. Build-artifact/VCS directories (.git, dist, build, " +
      "target, ...) are always skipped.",
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
