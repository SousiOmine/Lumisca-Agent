import {
  integer,
  object,
  optional,
  string,
  stringMap,
  type Tool,
} from "./schema.ts";
import { TOOL_BASH } from "../shared/mod.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import {
  type CommandRunner,
  MAX_RAW_COMMAND_OUTPUT,
} from "./command-backend.ts";
import { formatDuration } from "./duration.ts";
import { requireResolved } from "./resolve.ts";
import { safetyBlockResult } from "./safety.ts";
import {
  MAX_TOOL_OUTPUT,
  OutputSpiller,
  spilledNote,
  truncate,
  truncatedNote,
} from "./truncate.ts";
import type { FileBackend } from "./file-backend.ts";

/** Default and maximum wall-clock time one command may take. A model that
 * asks for a longer one is refused rather than silently clamped, and a
 * negative or zero value cannot slip through to the runner (a negative
 * timeout used to fire the kill immediately). */
export const DEFAULT_BASH_TIMEOUT_SEC = 120;
export const MAX_BASH_TIMEOUT_SEC = 3600;

const bashSchema = object({
  cwd: string(
    "Working directory: a workspace folder name (e.g. `Aaa`) or an absolute path",
  ),
  command: string("The shell command to execute"),
  timeout: optional(integer(
    "Timeout in seconds (default 120)",
    { min: 1, max: MAX_BASH_TIMEOUT_SEC },
  )),
  env: optional(stringMap("Environment variables to pass to the command")),
});

export interface BashToolOptions {
  /** File backend used to resolve the `cwd` argument (and to tell whether a
   * spilled output file is reachable through the file tools). */
  files: FileBackend;
  /** Where commands run: this machine, or the stella VM. */
  runner: CommandRunner;
  /** The working directory used when the caller omits `cwd`. Only a session
   * with a single place to work (the stella machine's per-agent folder) sets
   * this; a coding workspace has no such default, so its `cwd` argument
   * stays required. */
  defaultCwd?: string;
  /** Extra env vars to expose to every command this tool runs. A value the
   * model passes per call (`env`) wins over it; both win over the shell's
   * own environment (see tools/host/shell.ts). */
  env?: Record<string, string>;
  /** Command safety check (the fast model judges the command before it
   * runs; a blocked command returns the reason as the tool result).
   * Omitted → the command runs unchecked. */
  safety?: CommandSafety;
  /** Where a truncated stream spills its complete output. Defaults to a
   * directory under the file backend's first root, so the spill is readable
   * where the command ran; tests point it at a per-test directory. */
  spillDir?: string;
}

/** How to read a spilled file back. The `read`/`grep` tools resolve paths
 * through the file backend, so only a spill inside its roots is reachable
 * that way; anything else is only reachable through the shell that ran. */
async function spillRecovery(
  files: FileBackend,
  path: string,
): Promise<string> {
  if ((await files.resolve(path)).ok) {
    return "use read with offset/limit, or grep this path";
  }
  return "outside the workspace: read it with bash (sed -n '1,200p') or grep";
}

/**
 * Execute a shell command. Where it runs is the caller's choice: this
 * machine (HostCommandRunner: PowerShell on Windows, /bin/sh elsewhere) or
 * the stella VM (VmCommandRunner: `bash -lc` inside the container). The
 * working directory is a required argument, resolved against the file
 * backend; the command itself is not sandboxed beyond that.
 *
 * A stream longer than MAX_TOOL_OUTPUT keeps its last 64KiB inline and
 * spills the complete text through the same file backend (see
 * {@link OutputSpiller}), which the truncation note points at — so the model
 * can read the part that was cut instead of re-running the command.
 *
 * The wait policy (exit, never pipe EOF) lives in the runner; this tool
 * only decides what the model reads.
 */
export function createBashTool(
  options: BashToolOptions,
): Tool<typeof bashSchema> {
  const { files, runner } = options;
  const spiller = new OutputSpiller(files, options.spillDir);

  /** Note for a cut stream: spill the full text and point at it, or fall
   * back to the plain note when the spill could not be written (the result
   * must survive a failed spill). */
  const cutNote = async (kind: string, full: string): Promise<string> => {
    const path = await spiller.save(kind, full);
    if (path === undefined) return truncatedNote(kind, MAX_TOOL_OUTPUT);
    return spilledNote(kind, path, await spillRecovery(files, path));
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
    // A session with one working folder does not make the model repeat it on
    // every call (see defaultCwd). Injecting it here, before validation,
    // keeps the schema — and every caller that passes `cwd` — unchanged.
    ...(options.defaultCwd !== undefined
      ? {
        prepareArguments: (args: unknown) => {
          const record = typeof args === "object" && args !== null
            ? args as Record<string, unknown>
            : {};
          return record.cwd === undefined
            ? { ...record, cwd: options.defaultCwd as string }
            : record;
        },
      }
      : {}),
    execute: async (_id, params, signal) => {
      // Resolve the working directory before the safety check so the check
      // judges the exact context the command would run in.
      const cwd = await requireResolved(files, params.cwd);
      const blocked = await safetyBlockResult(
        options.safety,
        "bash",
        params.command,
        cwd,
      );
      if (blocked !== undefined) return blocked;
      const timeoutSec = params.timeout ?? DEFAULT_BASH_TIMEOUT_SEC;

      const result = await runner.run(params.command, {
        cwd,
        timeoutSec,
        ...(signal !== undefined ? { signal } : {}),
        ...(options.env !== undefined ? { baseEnv: options.env } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
        // The runner retains well past the tool's own cap: the tool keeps
        // the tail inline AND spills the complete text, so a stream cut only
        // by the runner would lose the head the spill exists to preserve.
        maxOutputChars: MAX_RAW_COMMAND_OUTPUT,
      });

      const { text: outTrimmed, truncated: outTruncated } = truncate(
        result.stdout,
        MAX_TOOL_OUTPUT,
      );
      const { text: errTrimmed, truncated: errTruncated } = truncate(
        result.stderr,
        MAX_TOOL_OUTPUT,
      );
      let body = outTrimmed;
      // The runner caps its own retained output; a stream it had to cut is
      // reported with the same note, using what it kept.
      if (result.stdoutTruncated) {
        body += await cutNote("stdout", result.stdout);
      }
      if (errTrimmed.length > 0) {
        body += body.length > 0 ? "\n\n[stderr]\n" : "";
        body += errTrimmed;
        if (result.stderrTruncated) {
          body += await cutNote("stderr", result.stderr);
        }
      }
      if (outTruncated && !result.stdoutTruncated) {
        body += await cutNote("stdout", result.stdout);
      }
      if (errTruncated && !result.stderrTruncated) {
        body += await cutNote("stderr", result.stderr);
      }
      if (result.orphanedOutput) {
        body += "\n[command left a process holding its output streams; later " +
          "output is not reported]";
      }
      body += `\n[exit code: ${result.exitCode ?? "?"}]`;
      body += `\n[duration: ${formatDuration(result.durationMs)}]`;
      return {
        content: [{ type: "text", text: body }],
        details: {
          exitCode: result.exitCode,
          cwd,
          durationMs: result.durationMs,
        },
      };
    },
    dispose: () => {
      void spiller.clear();
    },
  };
}
