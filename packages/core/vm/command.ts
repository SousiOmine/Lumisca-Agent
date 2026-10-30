/**
 * Running commands for the stella virtual machine: one `podman` invocation,
 * its output bounded, its failure turned into a sentence the caller can show.
 *
 * Everything the VM does to the outside world goes through this module — the
 * container manager, the file backend, the shell and the screen capture — so
 * the argument building, the output caps and the abort handling have exactly
 * one definition instead of drifting apart per caller.
 */
import { errorMessage } from "../errors.ts";

/** The result of one command, already decoded and capped. */
export interface VmCommandResult {
  /** Process exit code; -1 when the program could not be started at all. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the retained output was cut (the tail is kept). */
  truncated: boolean;
  /** True when the command outlived its timeout and was killed. */
  timedOut: boolean;
}

/** One command as bytes: for the screen capture, whose PNG must not pass
 * through a text decode. */
export interface VmCommandBytesResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface VmCommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Retained output, in characters (text runs) or bytes (byte runs). */
  maxOutput?: number;
  /** Which end of the output to keep. Default "tail" (the end of a log is
   * what a caller needs); "head" for a listing whose beginning is the point. */
  keep?: "head" | "tail";
  /** Data to write to the command's stdin. */
  stdin?: Uint8Array;
}

/** Runs one program with its arguments, no shell involved. Injected so the
 * tests drive the container manager without podman. */
export type VmCommandRunner = (
  command: readonly string[],
  options: VmCommandOptions,
) => Promise<VmCommandResult>;

/** The same, for commands whose output is binary. */
export type VmCommandBytesRunner = (
  command: readonly string[],
  options: VmCommandOptions,
) => Promise<VmCommandBytesResult>;

/** Default retained output for a text command (characters). */
export const VM_TEXT_OUTPUT_LIMIT = 64 * 1024;

/** Default retained output for a byte command (bytes): a 1280x800 PNG fits
 * comfortably, and a runaway output cannot exhaust memory. */
export const VM_BYTES_OUTPUT_LIMIT = 16 * 1024 * 1024;

/** Run one command with stdout/stderr as text. */
export async function runVmCommand(
  command: readonly string[],
  options: VmCommandOptions,
): Promise<VmCommandResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([options.signal, timeout]);
  let process: Deno.ChildProcess;
  try {
    process = new Deno.Command(command[0]!, {
      args: command.slice(1),
      stdin: options.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).spawn();
  } catch (error) {
    // A missing program (podman not installed) is a result, not a throw: the
    // caller reports it as the reason the machine is unavailable.
    return {
      exitCode: -1,
      stdout: "",
      stderr: errorMessage(error),
      truncated: false,
      timedOut: false,
    };
  }
  const writing = options.stdin === undefined
    ? Promise.resolve()
    : writeStdin(process, options.stdin);
  const limit = options.maxOutput ?? VM_TEXT_OUTPUT_LIMIT;
  const [stdout, stderr] = await Promise.all([
    readText(process.stdout, limit, options.keep ?? "tail"),
    readText(process.stderr, limit, options.keep ?? "tail"),
  ]);
  const code = await process.status;
  await writing;
  return {
    exitCode: code.code,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    timedOut: timeout.aborted && !(options.signal?.aborted ?? false),
  };
}

/** Run one command with stdout as raw bytes (stderr stays text). */
export async function runVmCommandBytes(
  command: readonly string[],
  options: VmCommandOptions,
): Promise<VmCommandBytesResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([options.signal, timeout]);
  let process: Deno.ChildProcess;
  try {
    process = new Deno.Command(command[0]!, {
      args: command.slice(1),
      stdin: options.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).spawn();
  } catch (error) {
    return {
      exitCode: -1,
      stdout: new Uint8Array(0),
      stderr: errorMessage(error),
      truncated: false,
      timedOut: false,
    };
  }
  const writing = options.stdin === undefined
    ? Promise.resolve()
    : writeStdin(process, options.stdin);
  const limit = options.maxOutput ?? VM_BYTES_OUTPUT_LIMIT;
  const [stdout, stderr] = await Promise.all([
    readBytes(process.stdout, limit, options.keep ?? "tail"),
    readText(process.stderr, VM_TEXT_OUTPUT_LIMIT, "tail"),
  ]);
  const code = await process.status;
  await writing;
  return {
    exitCode: code.code,
    stdout: stdout.bytes,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    timedOut: timeout.aborted && !(options.signal?.aborted ?? false),
  };
}

/** Feed `stdin` and close it. A command that exits without reading all of it
 * makes the write fail; that is not an error (the exit code says why). */
async function writeStdin(
  process: Deno.ChildProcess,
  stdin: Uint8Array,
): Promise<void> {
  const writer = process.stdin.getWriter();
  try {
    await writer.write(stdin);
  } catch {
    // The command stopped reading; its exit code carries the reason.
  } finally {
    try {
      await writer.close();
    } catch {
      // Already closed by the process exiting.
    }
  }
}

/** Read a pipe as text, keeping the requested end when it exceeds `limit`. */
async function readText(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  keep: "head" | "tail",
): Promise<{ text: string; truncated: boolean }> {
  const bytes = await readStream(stream, limit, keep);
  return {
    text: new TextDecoder().decode(bytes.bytes),
    truncated: bytes.truncated,
  };
}

/** Read a pipe as bytes, keeping the requested end when it exceeds `limit`. */
async function readBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  keep: "head" | "tail",
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  return await readStream(stream, limit, keep);
}

/**
 * Drain a pipe, retaining at most `limit` bytes. The whole stream is always
 * consumed (a command blocked on a full pipe would never finish), but only
 * the requested end is kept.
 */
async function readStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  keep: "head" | "tail",
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let keptLength = 0;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (keep === "head") {
        if (keptLength >= limit) continue;
        const room = limit - keptLength;
        const slice = value.length <= room ? value : value.subarray(0, room);
        kept.push(slice);
        keptLength += slice.length;
        continue;
      }
      kept.push(value);
      keptLength += value.length;
      // Trim the front as the buffer grows, so a huge stream never holds
      // more than the limit plus one chunk.
      while (keptLength > limit && kept.length > 0) {
        const excess = keptLength - limit;
        const first = kept[0]!;
        if (first.length <= excess) {
          kept.shift();
          keptLength -= first.length;
        } else {
          kept[0] = first.subarray(excess);
          keptLength -= excess;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    bytes: concat(kept, keptLength),
    truncated: total > limit,
  };
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
