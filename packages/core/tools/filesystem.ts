import { extname, join } from "node:path";
import type { Sandbox } from "../workspace/sandbox.ts";
import { TOOL_EDIT, TOOL_LIST_DIR, TOOL_READ, TOOL_WRITE } from "../shared.ts";
import { object, string, type Tool } from "./schema.ts";
import {
  DEFAULT_READ_LIMIT,
  MAX_TOOL_OUTPUT,
  truncate,
  truncatedNote,
} from "./truncate.ts";
import { requireResolved } from "./resolve.ts";

interface FsToolContext {
  sandbox: Sandbox;
}

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fileInfoLine(entry: Deno.DirEntry): string {
  if (entry.isDirectory) return `${entry.name}/`;
  if (entry.isSymlink) return `${entry.name} -> (symlink)`;
  return `${entry.name}`;
}

// --- line ranges --------------------------------------------------------------

/** One line range: 1-based, inclusive. */
interface LineRange {
  from: number;
  to: number;
}

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

/** Sort ranges by start and merge overlaps/adjacency, so membership checks
 * run against a small sorted list without materializing every line number. */
function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Strip a trailing `\r` so CRLF lines read back as clean LF lines (edits
 * match line endings leniently, so the raw bytes are not needed here). */
function stripTrailingCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Stream a file's lines as [1-based line number, text]. The trailing `\n`
 * and a trailing `\r` (CRLF files) are stripped, so the model always sees
 * LF-style lines. Stops early when the consumer breaks. */
async function* readLines(path: string): AsyncGenerator<[number, string]> {
  const file = await Deno.open(path, { read: true });
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(64 * 1024);
  let lineNo = 1;
  let carry = "";
  try {
    while (true) {
      const n = await file.read(buffer);
      if (n === null) break;
      carry += decoder.decode(buffer.subarray(0, n), { stream: true });
      // A single line can exceed the output budget by far (minified
      // files); keep only its tail so a line-ranged read never buffers
      // the whole file in memory.
      if (carry.length > MAX_TOOL_OUTPUT) {
        carry = carry.slice(-MAX_TOOL_OUTPUT);
      }
      let start = 0;
      for (let i = 0; i < carry.length; i++) {
        if (carry[i] === "\n") {
          yield [lineNo++, stripTrailingCR(carry.slice(start, i))];
          start = i + 1;
        }
      }
      carry = carry.slice(start);
    }
    const tail = carry + decoder.decode();
    if (tail.length > 0) yield [lineNo, stripTrailingCR(tail)];
  } finally {
    file.close();
  }
}

/** Read the requested line ranges, streaming; stops once the last needed
 * line is past. `endOfFile` reports whether the file ended before the
 * requested range was satisfied, `lastLine` the highest line seen. */
async function readLineRanges(
  path: string,
  ranges: LineRange[],
): Promise<{ lines: string[]; endOfFile: boolean; lastLine: number }> {
  const merged = mergeRanges(ranges);
  const maxTo = merged[merged.length - 1]!.to;
  const lines: string[] = [];
  let collectedBytes = 0;
  let startIndex = 0;
  let lastLine = 0;
  let index = 0;
  let pastMax = false;
  for await (const [no, text] of readLines(path)) {
    lastLine = no;
    while (index < merged.length && no > merged[index]!.to) index++;
    const current = merged[index];
    if (current === undefined) {
      pastMax = true;
      break;
    }
    if (no >= current.from) {
      lines.push(text);
      collectedBytes += text.length + 1;
      // Only the last MAX_TOOL_OUTPUT bytes can ever be displayed; drop
      // the front as the collection exceeds that (keeping at least one
      // line) so huge ranges stay memory-bounded.
      while (
        collectedBytes > MAX_TOOL_OUTPUT && startIndex < lines.length - 1
      ) {
        collectedBytes -= lines[startIndex]!.length + 1;
        startIndex++;
      }
    }
  }
  return {
    lines: lines.slice(startIndex),
    endOfFile: !pastMax && lastLine < maxTo,
    lastLine,
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
  return {
    name: TOOL_READ,
    label: "Read File",
    description:
      "Read a file's contents as text. Append a line range to the path to " +
      "read only those lines: `src/main.ts:50-100` (inclusive), " +
      "`src/main.ts:50+20` (50 lines starting at 50), or " +
      "`src/main.ts:5-16,960-973` (multiple ranges). Large files are read " +
      "in chunks; the output is truncated to the last 64KB. Raster images " +
      "(PNG/JPEG/GIF/WebP/BMP, up to 10MB) are passed to the model as images " +
      "when read in full.",
    parameters: readSchema,
    execute: async (_id, params, _signal) => {
      const { path, spec, ranges } = splitRangeSuffix(params.path);
      const filePath = await requireResolved(ctx.sandbox, path);
      const stat = await Deno.stat(filePath);
      if (stat.isDirectory) throw new Error(`Is a directory: ${params.path}`);

      if (ranges !== undefined) {
        const { lines, endOfFile, lastLine } = await readLineRanges(
          filePath,
          ranges,
        );
        const { text, truncated } = truncate(lines.join("\n"));
        let output = `--- ${path} lines ${spec} ---\n${text}`;
        if (truncated) output += truncatedNote("output");
        if (endOfFile) output += `\n[end of file: ${lastLine} lines]`;
        return {
          content: [{ type: "text", text: output }],
          details: { path: filePath, size: stat.size },
        };
      }

      // Whole-file read: image blocks for raster images, else text.
      const mimeType = IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()];
      if (mimeType !== undefined && stat.size <= MAX_IMAGE_BYTES) {
        const file = await Deno.open(filePath, { read: true });
        try {
          const buffer = new Uint8Array(stat.size);
          let read = 0;
          while (read < buffer.length) {
            const n = await file.read(buffer.subarray(read));
            if (n === null) break;
            read += n;
          }
          const name = filePath.split(/[\\/]/).pop() ?? filePath;
          return {
            content: [
              { type: "text", text: `[image: ${name} (${read} bytes)]` },
              {
                type: "image",
                data: bytesToBase64(buffer.subarray(0, read)),
                mimeType,
              },
            ],
            details: { path: filePath, size: stat.size },
          };
        } finally {
          file.close();
        }
      }

      const file = await Deno.open(filePath, { read: true });
      try {
        const buffer = new Uint8Array(DEFAULT_READ_LIMIT);
        const read = await file.read(buffer);
        const bytes = read === null
          ? new Uint8Array(0)
          : buffer.subarray(0, read);
        const text = new TextDecoder().decode(bytes);
        // Normalize CRLF so the model sees the same LF-style lines as
        // line-ranged reads (edits match line endings leniently).
        const { text: trimmed, truncated } = truncate(
          text.replaceAll("\r\n", "\n"),
        );
        let note = "";
        if (truncated) {
          note = truncatedNote("output");
        }
        if (bytes.length < stat.size) {
          const nextLine = countNewlines(bytes) + 1;
          note +=
            `\n[file continues; read with ${params.path}:${nextLine}+${SUGGESTED_RANGE_LINES}]`;
        }
        return {
          content: [{ type: "text", text: trimmed + note }],
          details: { path: filePath, size: stat.size },
        };
      } finally {
        file.close();
      }
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
  return {
    name: TOOL_WRITE,
    label: "Write File",
    description:
      "Create or overwrite a file with the given text content. Parent directories are created automatically.",
    parameters: writeSchema,
    execute: async (_id, params) => {
      const filePath = await requireResolved(ctx.sandbox, params.path);
      const parent = await requireResolved(ctx.sandbox, join(filePath, ".."));
      // Two concurrent writes to the same file would race (last write
      // wins); serialize per path like edits do.
      return withFileLock(filePath, async () => {
        await Deno.mkdir(parent, { recursive: true });
        // Keep an existing file's CRLF style when overwriting it, so a
        // full rewrite never flips the whole file to LF (new files stay
        // as sent, normally LF).
        let content = params.content;
        try {
          const existing = await Deno.readTextFile(filePath);
          if (existing.includes("\r\n")) {
            content = content.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
          }
        } catch {
          // File does not exist yet: write the content as-is.
        }
        await Deno.writeTextFile(filePath, content);
        return {
          content: [{ type: "text", text: `Wrote ${filePath}` }],
          details: { path: filePath, bytes: content.length },
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
  return {
    name: TOOL_EDIT,
    label: "Edit File",
    description:
      "Replace the first occurrence of `old_string` with `new_string` in a file. " +
      "`old_string` must appear at least once; line endings (CRLF vs LF) are " +
      "matched leniently and the replacement keeps the file's existing " +
      "line-ending style.",
    parameters: editSchema,
    execute: async (_id, params) => {
      const filePath = await requireResolved(ctx.sandbox, params.path);
      // read-modify-write must be atomic per file: parallel edits to the
      // same file would otherwise read the same pre-edit content and
      // overwrite each other (see withFileLock).
      return withFileLock(filePath, async () => {
        const content = await Deno.readTextFile(filePath);
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
        const origIndex = mapOffset(content, normIndex);
        const origEnd = mapOffset(content, normIndex + needle.length);
        const updated = content.slice(0, origIndex) +
          toFileNewlines(params.new_string, content) +
          content.slice(origEnd);
        await Deno.writeTextFile(filePath, updated);
        const note = occurrences > 1
          ? `\n[warning: old_string appeared ${occurrences} times; only the first was replaced]`
          : "";
        return {
          content: [{
            type: "text",
            text: `Edited ${filePath}${note}`,
          }],
          details: { path: filePath, replacements: 1, occurrences },
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
 * pi-agent-core executes the tool calls of one assistant message in
 * parallel (toolExecution defaults to "parallel"), so several edits to
 * the SAME file can run concurrently. Each edit is a read-modify-write
 * (read → replace → write) without atomicity; two concurrent edits would
 * both read the pre-edit content and the later write would silently
 * discard the earlier one (a lost update both report as "Edited").
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
  return {
    name: TOOL_LIST_DIR,
    label: "List Directory",
    description: "List the contents of a directory within the workspace.",
    parameters: listDirSchema,
    execute: async (_id, params) => {
      const dirPath = await requireResolved(ctx.sandbox, params.path);
      const entries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(dirPath)) {
        entries.push(entry);
      }
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
