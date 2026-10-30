import { errorMessage } from "../errors.ts";
import { TOOL_GLOB, TOOL_GREP } from "../shared/mod.ts";
import { MAX_GREP_FILE_SIZE } from "./host/files.ts";
import {
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
} from "./schema.ts";
import { truncate, truncatedNote } from "./truncate.ts";
import type { FsToolContext } from "./context.ts";

/**
 * The grep / glob tools.
 *
 * Both hand their whole search to the file backend (`FileBackend.grep` /
 * `.glob`), which is what keeps one behaviour across the host and the stella
 * VM: the host walks the tree in memory, the VM runs the container's own
 * grep/find, and both return the same shapes — `path:line: text` for grep,
 * absolute paths for glob. The policy the two share (pruned build-artifact
 * and VCS directories, symlinks never followed, `.gitignore`) is documented
 * on the request types and implemented by each backend.
 *
 * What stays here is everything the model reads: argument validation, the
 * pattern-length caps (a model-supplied regex is evaluated without a
 * timeout, so its length is bounded), and the wording of the truncation and
 * cap notes.
 */

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

/** Format a capped search result: the hits, the byte-truncation note and
 * the cap note. Shared so grep (`matches`) and glob (`paths`) phrase their
 * limits identically — the model reads both and compares them. */
function cappedResult(
  hits: readonly string[],
  maxResults: number,
  what: string,
): string {
  const { text, truncated } = truncate(hits.join("\n"));
  const note = truncated ? truncatedNote(what) : "";
  const capped = hits.length >= maxResults
    ? `\n[maximum of ${maxResults} ${what} reached]`
    : "";
  return text + note + capped;
}

export function createGrepTool(
  ctx: FsToolContext,
): Tool<typeof grepSchema> {
  const files = ctx.files;
  return {
    name: TOOL_GREP,
    label: "Grep",
    description: "Search file contents within the workspace using a regular " +
      "expression; matches are returned as path:line: text. Binary files, " +
      "files larger than 8MB, and build-artifact/VCS directories (.git, " +
      "dist, build, target, ...) are skipped. Results are capped: a capped " +
      "result ends with `[maximum of N matches reached]` and/or `[matches " +
      "truncated to the last 65536 bytes]`.",
    parameters: grepSchema,
    execute: async (_id, params) => {
      if (params.pattern.length > MAX_GREP_PATTERN_CHARS) {
        throw new Error(
          `pattern is too long (max ${MAX_GREP_PATTERN_CHARS} chars)`,
        );
      }
      // Compiled here once so an invalid pattern fails with its own message
      // before any search work starts (the backend compiles it again for
      // its own lines; the cost is one RegExp construction per call).
      try {
        new RegExp(params.pattern, params.case ? "" : "i");
      } catch (error) {
        throw new Error(`Invalid pattern: ${errorMessage(error)}`);
      }
      const maxResults = Math.min(params.max_results ?? 200, 1000);
      const result = await files.grep({
        ...(params.path !== undefined ? { path: params.path } : {}),
        pattern: params.pattern,
        caseSensitive: params.case === true,
        gitignore: params.gitignore !== false,
        // grep has never had a hidden-file flag: it searches dot-prefixed
        // files too (only .gitignore and the artefact pruning hide things).
        hidden: true,
        maxResults,
        maxFileSize: MAX_GREP_FILE_SIZE,
      });
      return {
        content: [{
          type: "text",
          text: cappedResult(result.lines, maxResults, "matches"),
        }],
        details: { matches: result.lines.length, files: result.files },
      };
    },
  };
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
  const files = ctx.files;
  return {
    name: TOOL_GLOB,
    label: "Glob",
    description:
      "Find files by path pattern within the workspace. Supports `**`, `*`, " +
      "`?` and `{a,b}`. Build-artifact/VCS directories (.git, dist, build, " +
      "target, ...) are always skipped. Results are capped: a capped result " +
      "ends with `[maximum of N paths reached]` and/or `[paths truncated to " +
      "the last 65536 bytes]`.",
    parameters: globSchema,
    execute: async (_id, params) => {
      if (params.pattern.length > MAX_GLOB_PATTERN_CHARS) {
        throw new Error(
          `pattern is too long (max ${MAX_GLOB_PATTERN_CHARS} chars)`,
        );
      }
      const maxResults = Math.min(params.max_results ?? 500, 2000);
      const found = await files.glob({
        ...(params.path !== undefined ? { path: params.path } : {}),
        pattern: params.pattern,
        gitignore: params.gitignore !== false,
        hidden: params.hidden !== false,
        maxResults,
      });
      return {
        content: [{
          type: "text",
          text: cappedResult(found, maxResults, "paths"),
        }],
        details: { count: found.length },
      };
    },
  };
}
