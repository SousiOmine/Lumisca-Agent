import { mergeRanges, stripTrailingCR } from "../../lines.ts";
import { runtime } from "../../runtime/runtime.ts";
import type { ResolvedPath, Sandbox } from "../../workspace/sandbox.ts";
import type {
  BackendDirEntry,
  BackendStat,
  FileBackend,
  LineRange,
  RangeReadResult,
} from "../file-backend.ts";
import { MAX_TOOL_OUTPUT } from "../truncate.ts";

/**
 * The host (this machine) implementation of {@link FileBackend}: a workspace
 * sandbox for path resolution plus the Deno filesystem for everything else.
 */
export class HostFileBackend implements FileBackend {
  readonly roots: readonly string[];
  readonly #sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.#sandbox = sandbox;
    this.roots = sandbox.roots;
  }

  resolve(requested: string): Promise<ResolvedPath> {
    return this.#sandbox.resolve(requested);
  }

  async stat(path: string): Promise<BackendStat | undefined> {
    const stat = await runtime.stat(path).catch(() => null);
    if (stat === null) return undefined;
    return { isFile: stat.isFile, size: stat.size };
  }

  readText(path: string): Promise<string> {
    return runtime.readTextFile(path);
  }

  async readHead(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; size: number }> {
    const stat = await runtime.stat(path);
    const file = await runtime.open(path, { read: true });
    try {
      const buffer = new Uint8Array(Math.min(maxBytes, stat.size));
      let read = 0;
      while (read < buffer.length) {
        const n = await file.read(buffer.subarray(read));
        if (n === null) break;
        read += n;
      }
      return { bytes: buffer.subarray(0, read), size: stat.size };
    } finally {
      file.close();
    }
  }

  async writeText(
    path: string,
    text: string,
    options: { private?: boolean } = {},
  ): Promise<void> {
    await runtime.mkdir(parentOf(path), { recursive: true });
    await runtime.writeTextFile(
      path,
      text,
      options.private === true ? { mode: 0o600 } : {},
    );
  }

  async removeFile(path: string): Promise<void> {
    // Pruning is best effort: a missing file means another prune (or the
    // model) got there first, which is the outcome the caller wanted.
    await runtime.remove(path).catch(() => {});
  }

  async readRanges(
    path: string,
    ranges: readonly LineRange[],
  ): Promise<RangeReadResult> {
    const merged = mergeRanges(ranges);
    const maxTo = merged[merged.length - 1]!.to;
    const lines: string[] = [];
    let startIndex = 0;
    let collectedBytes = 0;
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
          collectedBytes > MAX_TOOL_OUTPUT &&
          startIndex < lines.length - 1
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
      droppedLines: startIndex,
      truncatedTail: false,
    };
  }

  async listDir(path: string): Promise<BackendDirEntry[]> {
    const entries: BackendDirEntry[] = [];
    for await (const entry of runtime.readDir(path)) {
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
      });
    }
    return entries;
  }
}

/** Stream a file's lines as [1-based line number, text]. The trailing `\n`
 * and a trailing `\r` (CRLF files) are stripped, so the model always sees
 * LF-style lines. Stops early when the consumer breaks. */
async function* readLines(path: string): AsyncGenerator<[number, string]> {
  const file = await runtime.open(path, { read: true });
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
      if (carry.length > MAX_TOOL_OUTPUT) carry = carry.slice(-MAX_TOOL_OUTPUT);
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

/** Parent directory of an absolute path, without a `node:path` round trip
 * for the common case of a path that has a separator. */
function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}
