import { extname } from "node:path";
import {
  decodeUtf8,
  diffLineCounts,
  TOOL_EDIT,
  TOOL_LIST_DIR,
  TOOL_READ,
  TOOL_WRITE,
} from "../shared/mod.ts";
import { object, string, type Tool } from "./schema.ts";
import {
  DEFAULT_READ_LIMIT,
  MAX_TOOL_OUTPUT,
  truncate,
  truncatedNote,
} from "./truncate.ts";
import { bytesToBase64 } from "../base64.ts";
import type { FsToolContext } from "./context.ts";
import type { BackendDirEntry, LineRange } from "./file-backend.ts";
import { requireExistingFile, requireResolved } from "./resolve.ts";

/** Raster image extensions read as image content blocks (vision models see
 * the pixels). Vector images (SVG) are XML and stay on the text path. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** Largest image handed to the model as an image block; anything bigger
 * falls back to the (garbled) text read. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Line count suggested by the "file continues" note for a next chunk. */
const SUGGESTED_RANGE_LINES = 2000;

function fileInfoLine(entry: BackendDirEntry): string {
  if (entry.isDirectory) return `${entry.name}/`;
  if (entry.isSymlink) return `${entry.name} -> (symlink)`;
  return `${entry.name}`;
}

/** Resolve a path, throwing the rejection reason (the wording every tool
 * shares). Re-exported from resolve.ts so this module's tools need one
 * import for both helpers. */
export { requireExistingFile, requireResolved } from "./resolve.ts";

// --- line ranges --------------------------------------------------------------

/** One comma-separated segment: `50`, `50-100` or `50+20`. */
const RANGE_SEGMENT = /^(\d+)(?:-(\d+)|\+(\d+))?$/;

/** Full range-list grammar: `50-100`, `50+20`, `5-16,960-973`, … */
const RANGE_LIST = /^\d+(?:-\d+|\+\d+)?(?:,\d+(?:-\d+|\+\d+)?)*$/;

function invalidRange(path: string, spec: string): Error {
  return new Error(
    `Invalid line range "${spec}" in "${path}": expected e.g. "50-100", "50+20" or "5-16,960-973"`,
  );
}

/** Split a requested path into the file path and its optional line range
 * suffix. The text after the last `:` is treated as a range only when it
 * fully matches the range grammar, so Windows drive letters (`C:\...`) and
 * colons inside file names stay part of the path. Suffixes that do not match
 * the grammar at all are not ranges and stay in the path (the resolver then
 * reports them as a missing file). */
function splitRangeSuffix(
  requested: string,
): { path: string; spec: string; ranges: LineRange[] | undefined } {
  const colon = requested.lastIndexOf(":");
  if (colon === -1) return { path: requested, spec: "", ranges: undefined };
  const spec = requested.slice(colon + 1);
  if (!RANGE_LIST.test(spec)) {
    return { path: requested, spec: "", ranges: undefined };
  }
  const ranges: LineRange[] = [];
  for (const segment of spec.split(",")) {
    const match = RANGE_SEGMENT.exec(segment);
    if (match === null) throw invalidRange(requested, spec);
    const from = Number(match[1]);
    let to: number;
    if (match[2] !== undefined) {
      to = Number(match[2]);
      if (to < from) throw invalidRange(requested, spec);
    } else if (match[3] !== undefined) {
      const count = Number(match[3]);
      if (count < 1) throw invalidRange(requested, spec);
      to = from + count - 1;
    } else {
      to = from;
    }
    if (from < 1) throw invalidRange(requested, spec);
    ranges.push({ from, to });
  }
  return { path: requested.slice(0, colon), spec, ranges };
}

/** Trim a ranged read to what can be displayed: the model sees the tail of
 * the last MAX_TOOL_OUTPUT bytes, so drop the front of an oversized range
 * (keeping at least one line) instead of handing over an unbounded string. */
function capRangeLines(lines: readonly string[]): {
  lines: string[];
  truncated: boolean;
} {
  let bytes = 0;
  let start = 0;
  for (const line of lines) bytes += line.length + 1;
  while (bytes > MAX_TOOL_OUTPUT && start < lines.length - 1) {
    bytes -= lines[start]!.length + 1;
    start++;
  }
  return {
    lines: lines.slice(start),
    truncated: start > 0,
  };
}

function countNewlines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) count++;
  }
  return count;
}

const readSchema = object({
  path: string(
    "Path to the file, optionally with a line range: `src/main.ts:50-100`, `src/main.ts:50+20` (50 lines from 50), or `src/main.ts:5-16,960-973` (multiple ranges)",
  ),
});

export function createReadFileTool(
  ctx: FsToolContext,
): Tool<typeof readSchema> {
  const files = ctx.files;
  return {
    name: TOOL_READ,
    label: "Read File",
    description:
      "Read a file's contents as text. Append a line range to the path to " +
      "read only those lines: `src/main.ts:50-100` (inclusive), " +
      "`src/main.ts:50+20` (50 lines starting at 50), or " +
      "`src/main.ts:5-16,960-973` (multiple ranges). Raster images " +
      "(PNG/JPEG/GIF/WebP/BMP, up to 10MB) are passed to the model as images " +
      "when read in full. A whole-file read keeps at most " +
      `${Math.floor(DEFAULT_READ_LIMIT / 1024)}KB of the file: a file that ` +
      "continues past that point ends with `[file continues; read with " +
      "<path>:<line>+2000]`. A ranged read ends with `[end of file: N " +
      "lines]` when it reached the last line.",
    parameters: readSchema,
    execute: async (_id, params) => {
      const { path, spec, ranges } = splitRangeSuffix(params.path);
      // The range suffix is not part of the file path, so the existence and
      // type check runs on the path alone (its message then names the file).
      const filePath = await requireExistingFile(files, path);
      const stat = await files.stat(filePath);
      // requireExistingFile proved it exists; the second stat is the size
      // the read below decides on.
      const size = stat?.size ?? 0;

      if (ranges !== undefined) {
        const { lines, endOfFile, lastLine } = await files.readRanges(
          filePath,
          ranges,
        );
        const { lines: kept, truncated } = capRangeLines(lines);
        let output = `--- ${path} lines ${spec} ---\n${kept.join("\n")}`;
        if (truncated) output += truncatedNote("output");
        if (endOfFile) output += `\n[end of file: ${lastLine} lines]`;
        return {
          content: [{ type: "text", text: output }],
          details: { path: filePath, size },
        };
      }
      // Whole-file read: image blocks for raster images, else text.
      const mimeType = IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()];
      if (mimeType !== undefined && size <= MAX_IMAGE_BYTES) {
        const { bytes } = await files.readHead(filePath, size);
        const name = filePath.split(/[\\/]/).pop() ?? filePath;
        return {
          content: [
            { type: "text", text: `[image: ${name} (${bytes.length} bytes)]` },
            {
              type: "image",
              data: bytesToBase64(bytes),
              mimeType,
            },
          ],
          details: { path: filePath, size },
        };
      }

      const { bytes, size: actualSize } = await files.readHead(
        filePath,
        DEFAULT_READ_LIMIT,
      );
      const text = decodeUtf8(bytes);
      // Normalize CRLF so the model sees the same LF-style lines as
      // line-ranged reads (edits match line endings leniently).
      const { text: trimmed, truncated } = truncate(
        text.replaceAll("\r\n", "\n"),
      );
      let note = "";
      if (truncated) note = truncatedNote("output");
      if (bytes.length < actualSize) {
        const nextLine = countNewlines(bytes) + 1;
        note +=
          `\n[file continues; read with ${params.path}:${nextLine}+${SUGGESTED_RANGE_LINES}]`;
      }
      return {
        content: [{ type: "text", text: trimmed + note }],
        details: { path: filePath, size: stat?.size ?? size },
      };
    },
  };
}

const writeSchema = object({
  path: string("Path to the file"),
  content: string("Full text content to write"),
});

export function createWriteFileTool(
  ctx: FsToolContext,
): Tool<typeof writeSchema> {
  const files = ctx.files;
  return {
    name: TOOL_WRITE,
    label: "Write File",
    description:
      "Create or overwrite a file with the given text content. Parent " +
      "directories are created automatically. Overwriting keeps the " +
      "existing file's line-ending style (CRLF stays CRLF).",
    parameters: writeSchema,
    execute: async (_id, params) => {
      const filePath = await requireResolved(files, params.path);
      // Two concurrent writes to the same file would race (last write
      // wins); serialize per path like edits do.
      return withFileLock(filePath, async () => {
        // Keep an existing file's CRLF style when overwriting it, so a
        // full rewrite never flips the whole file to LF (new files stay
        // as sent, normally LF).
        let content = params.content;
        let previous = "";
        try {
          previous = await files.readText(filePath);
          if (previous.includes("\r\n")) {
            content = content.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
          }
        } catch {
          // File does not exist yet: write the content as-is.
        }
        await files.writeText(filePath, content);
        const { addedLines, removedLines } = diffLineCounts(previous, content);
        return {
          content: [{ type: "text", text: `Wrote ${filePath}` }],
          details: {
            path: filePath,
            bytes: content.length,
            addedLines,
            removedLines,
          },
        };
      });
    },
  };
}

const editSchema = object({
  path: string("Path to the file"),
  old_string: string("Text to find (exact match)"),
  new_string: string("Replacement text"),
});

/** Map an offset in a CRLF-normalized string (`\r\n` shrunk to `\n`) back to
 * the matching offset in the original string. Offsets never cross `\n`, so
 * walking the original string side by side stays exact. */
function mapOffset(original: string, normOffset: number): number {
  let normSeen = 0;
  let origSeen = 0;
  while (normSeen < normOffset && origSeen < original.length) {
    if (original[origSeen] === "\r" && original[origSeen + 1] === "\n") {
      origSeen += 2;
    } else {
      origSeen += 1;
    }
    normSeen += 1;
  }
  return origSeen;
}

/** Convert `new_string` to the file's line-ending style so an edit never
 * introduces mixed line endings. */
function toFileNewlines(newString: string, fileContent: string): string {
  if (!fileContent.includes("\r\n")) return newString;
  return newString.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
}

export function createEditFileTool(
  ctx: FsToolContext,
): Tool<typeof editSchema> {
  const files = ctx.files;
  return {
    name: TOOL_EDIT,
    label: "Edit File",
    description:
      "Replace `old_string` with `new_string` in a file. `old_string` must " +
      "appear exactly once: a missing match fails with `old_string not " +
      "found in <path>`, and an ambiguous match fails with `old_string " +
      "appears N times in <path>` without changing the file — include more " +
      "surrounding context to make it unique. Line endings (CRLF vs LF) are " +
      "matched leniently and the replacement keeps the file's existing " +
      "line-ending style.",
    parameters: editSchema,
    execute: async (_id, params) => {
      const filePath = await requireResolved(files, params.path);
      // read-modify-write must be atomic per file: parallel edits to the
      // same file would otherwise read the same pre-edit content and
      // overwrite each other (see withFileLock).
      return withFileLock(filePath, async () => {
        const content = await files.readText(filePath);
        // Match leniently: models usually reproduce `old_string` with LF
        // even when the file is CRLF, so compare both sides normalized to
        // LF and map the match position back into the original bytes.
        const normalized = content.replaceAll("\r\n", "\n");
        const needle = params.old_string.replaceAll("\r\n", "\n");
        const normIndex = normalized.indexOf(needle);
        if (normIndex === -1) {
          throw new Error(`old_string not found in ${params.path}`);
        }
        const occurrences = normalized.split(needle).length - 1;
        // Ambiguous matches are refused, never resolved by picking one:
        // replacing the first of several matches can silently rewrite the
        // wrong place, while failing makes the model retry with enough
        // context to identify the intended one.
        if (occurrences > 1) {
          throw new Error(
            `old_string appears ${occurrences} times in ${params.path}; ` +
              "include more surrounding context to make it unique",
          );
        }
        const origIndex = mapOffset(content, normIndex);
        const origEnd = mapOffset(content, normIndex + needle.length);
        const updated = content.slice(0, origIndex) +
          toFileNewlines(params.new_string, content) +
          content.slice(origEnd);
        await files.writeText(filePath, updated);
        const { addedLines, removedLines } = diffLineCounts(
          params.old_string,
          params.new_string,
        );
        return {
          content: [{ type: "text", text: `Edited ${filePath}` }],
          details: {
            path: filePath,
            replacements: 1,
            occurrences,
            addedLines,
            removedLines,
          },
        };
      });
    },
  };
}

const listDirSchema = object({
  path: string("Path to the directory"),
});

// --- per-file serialization ------------------------------------------------

/**
 * The tool calls of one assistant message may run concurrently (the AI SDK
 * executes a step's tool calls in parallel, and the agent's fallback path
 * covers test doubles), so several edits to the SAME file can overlap.
 * Each edit is a read-modify-write (read → replace → write) without
 * atomicity; two concurrent edits would both read the pre-edit content and
 * the later write would silently discard the earlier one (a lost update
 * both report as "Edited").
 *
 * The lock serializes operations per resolved file path: concurrent edits
 * to one file queue up and each sees the previous operation's result;
 * edits to different files still run in parallel. (The eval tool solves
 * the same problem for its shared REPL session with an internal queue;
 * here the queue is keyed by file path.)
 */
const fileLocks = new Map<string, Promise<unknown>>();

/** Run `fn` while holding the per-path lock of `path`; operations on the
 * same path run one after another, other paths stay independent. The lock
 * is implicitly released when `fn` settles, and a failed operation never
 * blocks the next one. */
function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  // `catch` keeps the chain alive after a failed operation.
  const next = previous.catch(() => {}).then(fn);
  fileLocks.set(path, next);
  // Drop the entry once it is no longer the tail of the queue, so the map
  // cannot grow with finished operations. The `catch` swallows the
  // finally-chain's rejection (the caller already observes `next`'s own
  // failure) so an expected tool error cannot become an unhandled
  // rejection.
  next.finally(() => {
    if (fileLocks.get(path) === next) fileLocks.delete(path);
  }).catch(() => {});
  return next;
}

export function createListDirTool(
  ctx: FsToolContext,
): Tool<typeof listDirSchema> {
  const files = ctx.files;
  return {
    name: TOOL_LIST_DIR,
    label: "List Directory",
    description:
      "List the contents of a directory within the workspace, sorted by " +
      "name (directories carry a trailing `/`). A listing cut by the output " +
      "cap ends with `[listing truncated to the last 65536 bytes]`.",
    parameters: listDirSchema,
    execute: async (_id, params) => {
      const dirPath = await requireResolved(files, params.path);
      const entries = await files.listDir(dirPath);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const lines = entries.map((e) => fileInfoLine(e));
      const { text, truncated } = truncate(lines.join("\n") || "(empty)");
      const note = truncated ? truncatedNote("listing") : "";
      return {
        content: [{ type: "text", text: `${dirPath}:\n${text}${note}` }],
        details: { path: dirPath, count: entries.length },
      };
    },
  };
}
