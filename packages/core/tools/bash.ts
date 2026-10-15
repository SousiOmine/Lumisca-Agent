import {
  integer,
  object,
  optional,
  string,
  stringMap,
  type Tool,
} from "./schema.ts";
import { TOOL_BASH } from "../shared/mod.ts";
import type { Sandbox } from "../workspace/sandbox.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import { FINAL_FLUSH_GRACE_MS, KILL_WAIT_MS } from "./background.ts";
import { decodeOutput, detectOemLabel } from "./decode.ts";
import { formatDuration } from "./duration.ts";
import { killProcessTree } from "./process-tree.ts";
import { shellCommand } from "./shell.ts";
import { requireResolved } from "./resolve.ts";
import { safetyBlockResult } from "./safety.ts";
import {
  MAX_TOOL_OUTPUT,
  OutputSpiller,
  spilledNote,
  truncate,
  truncatedNote,
} from "./truncate.ts";

const bashSchema = object({
  cwd: string(
    "Working directory: a workspace folder name (e.g. `Aaa`) or an absolute path",
  ),
  command: string("The shell command to execute"),
  timeout: optional(integer("Timeout in seconds (default 120)")),
  env: optional(stringMap("Environment variables to pass to the command")),
});

export interface BashToolOptions {
  /** Workspace sandbox used to resolve the `cwd` argument. */
  sandbox: Sandbox;
  /** Extra env vars to expose. */
  env?: Record<string, string>;
  /** Default timeout in seconds. */
  defaultTimeoutSec?: number;
  /** Command safety check (the fast model judges the command before it
   * runs; a blocked command returns the reason as the tool result).
   * Omitted → the command runs unchecked. */
  safety?: CommandSafety;
  /** Where a truncated stream spills its complete output. Defaults to the
   * OS temp dir (`defaultSpillDir()`); tests point it at a per-test
   * directory so a run never shares (or cleans up) the real one. */
  spillDir?: string;
}

/** How to read a spilled file back. The `read`/`grep` tools resolve paths
 * through the workspace sandbox, so only a spill inside the workspace is
 * reachable that way — the default spill directory lives in the OS temp
 * dir, where bash is the way in. */
async function spillRecovery(sandbox: Sandbox, path: string): Promise<string> {
  if ((await sandbox.resolve(path)).ok) {
    return "use read with offset/limit, or grep this path";
  }
  return "outside the workspace: read it with bash (sed -n '1,200p') or grep";
}

/** Drain one of the child's pipes into `chunks`; resolves at EOF, or when
 * the reader is cancelled — which is how the tool stops waiting. */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      chunks.push(value);
    }
  } catch {
    // The pipe was closed under us (a kill, or the cancel in `execute`):
    // what was read is the output.
  }
}

/** Join the chunks read from one stream. */
function join(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * Execute a shell command. On Windows uses PowerShell (pwsh if installed,
 * else Windows PowerShell), elsewhere /bin/sh. The working directory is a
 * required argument, resolved against the workspace; the command itself is
 * not sandboxed beyond that (same policy as pi).
 *
 * A stream longer than MAX_TOOL_OUTPUT keeps its last 64KiB inline and
 * spills the complete text to a file (see {@link OutputSpiller}), which the
 * truncation note points at — so the model can read the part that was cut
 * instead of re-running the command.
 *
 * The wait is on the command's own exit, never on the pipes' EOF: a process
 * the command leaves behind inherits the pipes and can hold them open for
 * as long as it lives, and waiting for their EOF used to hang the call (and
 * with it the whole session). The pipes are read by hand for that reason.
 */
export function createBashTool(
  options: BashToolOptions,
): Tool<typeof bashSchema> {
  const defaultTimeoutSec = options.defaultTimeoutSec ?? 120;
  const spiller = new OutputSpiller(options.spillDir);

  /** Note for a cut stream: spill the full text and point at it, or fall
   * back to the plain note when the spill could not be written (the result
   * must survive a failed spill). */
  const cutNote = async (kind: string, full: string): Promise<string> => {
    const path = await spiller.save(kind, full);
    if (path === undefined) return truncatedNote(kind, MAX_TOOL_OUTPUT);
    return spilledNote(kind, path, await spillRecovery(options.sandbox, path));
  };

  return {
    name: TOOL_BASH,
    label: "Bash",
    description:
      "Execute a shell command in the workspace and return its output; a " +
      "command that outlives `timeout` is killed. Every result ends with " +
      "`[exit code: N]` — a kill reports the kill's exit code — followed by " +
      "`[duration: X]`, how long the command ran (`850ms`, `1.4s`, `12s`, " +
      "`2m 05s`). stdout and stderr are capped separately: a cut stream " +
      "keeps its last 65536 bytes and ends with `[stdout truncated to the " +
      "last 65536 bytes; full output: <path>]` — that file holds the whole " +
      "stream, so read it back (bash: `sed -n '1,200p' <path>` or grep; " +
      "`read` with offset/limit when the path is inside the workspace) " +
      "instead of re-running the command. A command that leaves a process " +
      "of its own holding the output streams (a `server &`) is reported " +
      "with `[command left a process holding its output streams; later " +
      "output is not reported]` and returns without waiting for that " +
      "process. On Windows the shell " +
      "is PowerShell (7 if installed, else Windows PowerShell, with Git Bash " +
      "or cmd.exe as a fallback); on macOS/Linux it is /bin/sh.",
    parameters: bashSchema,
    execute: async (_id, params, signal) => {
      // Resolve the working directory before the safety check so the check
      // judges the exact context the command would run in.
      const cwd = await requireResolved(options.sandbox, params.cwd);
      const blocked = await safetyBlockResult(
        options.safety,
        "bash",
        params.command,
        cwd,
      );
      if (blocked !== undefined) return blocked;
      const timeoutSec = params.timeout ?? defaultTimeoutSec;

      // Per-call env vars override the tool-level env and the shell env.
      const command = shellCommand({
        command: params.command,
        cwd,
        baseEnv: options.env,
        env: params.env,
      });

      const startedAt = performance.now();
      const child = command.spawn();
      // The pipes are read here rather than through child.output(): that
      // call waits for their EOF, and the wait below must not (see there).
      // The readers are held, not the streams, because the tool cancels
      // them once it stops waiting. Everything read is kept: a truncated
      // stream spills its complete text (see cutNote).
      const outChunks: Uint8Array[] = [];
      const errChunks: Uint8Array[] = [];
      const outReader = child.stdout.getReader();
      const errReader = child.stderr.getReader();
      const readers = [
        drain(outReader, outChunks),
        drain(errReader, errChunks),
      ];

      // Fire-and-forget: the timeout/abort path must not await the kill
      // (the exit wait below already covers it).
      const kill = () => void killProcessTree(child);
      const onAbort = () => kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(kill, timeoutSec * 1000);
      // The two bounds the wait below adds; cleared in `finally` so a call
      // leaves no timer behind.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let flushGiveUp: ReturnType<typeof setTimeout> | undefined;

      try {
        // The command's own exit ends the wait — never its pipes' EOF. A
        // process the command leaves behind (a `server &`) inherits the
        // pipes and keeps them open for as long as it lives, and no kill
        // can close a pipe that other process holds: waiting for EOF hung
        // this tool, its step and the whole session for good. The exit is
        // bounded by the kill above, and this deadline (the timer that
        // issued the kill, plus the bound that kill itself is held to)
        // covers a process that survives it — nothing else bounds the wait.
        const status = await Promise.race([
          child.status,
          new Promise<undefined>((resolve) => {
            deadline = setTimeout(
              () => resolve(undefined),
              timeoutSec * 1000 + KILL_WAIT_MS,
            );
          }),
        ]);
        // The command's last output can still be in flight when it exits:
        // the readers get a grace to flush it (bounded, because the pipes
        // may never close). "Drained" is what tells the two cases apart.
        const drained = await Promise.race([
          Promise.all(readers).then(() => true),
          new Promise<boolean>((resolve) => {
            flushGiveUp = setTimeout(
              () => resolve(false),
              FINAL_FLUSH_GRACE_MS,
            );
          }),
        ]);
        if (!drained) {
          // The tool answers for the command's own lifetime and stops there:
          // close the pipes rather than drain a process it no longer waits
          // for (a lingering reader would hold the pipe — a file descriptor
          // and an open handle — for as long as that process lives, and
          // consume everything it writes).
          await Promise.all([outReader.cancel(), errReader.cancel()]);
        }
        // Measured from before spawn() to the flushed readers: this is what
        // the agent waited for (shell startup included), not just the
        // child's own runtime. Decoding happens after the clock stops.
        const durationMs = Math.round(performance.now() - startedAt);
        const oemLabel = await detectOemLabel();
        const outText = decodeOutput(join(outChunks), oemLabel);
        const errText = decodeOutput(join(errChunks), oemLabel);
        const { text: outTrimmed, truncated: outTruncated } = truncate(
          outText,
          MAX_TOOL_OUTPUT,
        );
        const { text: errTrimmed, truncated: errTruncated } = truncate(
          errText,
          MAX_TOOL_OUTPUT,
        );
        let body = outTrimmed;
        if (outTruncated) body += await cutNote("stdout", outText);
        if (errTrimmed.length > 0) {
          body += body.length > 0 ? "\n\n[stderr]\n" : "";
          body += errTrimmed;
          if (errTruncated) body += await cutNote("stderr", errText);
        }
        if (!drained) {
          body +=
            "\n[command left a process holding its output streams; later " +
            "output is not reported]";
        }
        body += `\n[exit code: ${status?.code ?? "?"}]`;
        body += `\n[duration: ${formatDuration(durationMs)}]`;
        return {
          content: [{ type: "text", text: body }],
          details: { exitCode: status?.code, cwd, durationMs },
        };
      } catch (error) {
        // A spawn-time failure or a pipe error: make sure the tree is dead
        // before surfacing the failure — a stray process would keep running
        // (and hold the pipes) otherwise.
        kill();
        throw error;
      } finally {
        clearTimeout(timer);
        clearTimeout(deadline);
        clearTimeout(flushGiveUp);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
