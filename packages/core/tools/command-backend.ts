/**
 * The command-execution surface the `bash` tool runs against.
 *
 * `bash` needs one thing from wherever it runs: run a command string in a
 * directory with a timeout and an abort, and get back decoded stdout/stderr
 * with an exit code. The host runs `/bin/sh` (PowerShell on Windows) on this
 * machine; the stella VM runs `bash -lc` through `podman exec`. Those have
 * different process models — the host streams pipes and can kill a process
 * tree, the container call is one request — so the port keeps only what both
 * can honour.
 *
 * Everything the MODEL reads (the `[exit code: N]` / `[duration: X]` footer,
 * the truncation notes and how a cut stream's full output is recovered) stays
 * in tools/bash.ts, so both backends produce the same text for the same
 * outcome.
 */
export interface CommandRunner {
  /**
   * Run one command to completion, its timeout, or the caller's abort.
   * Implementations must not reject for a command that ran and failed —
   * that is a result with a non-zero exit code. They reject only when the
   * command could not be started at all.
   */
  run(command: string, options: RunOptions): Promise<ShellRunResult>;
}

export interface RunOptions {
  /** Absolute working directory the command runs in. */
  cwd: string;
  /** Seconds before the command is killed. */
  timeoutSec: number;
  /** Aborting settles the call promptly; the command is killed. */
  signal?: AbortSignal;
  /** The owning tool's own environment (the tool's `env` option). Merged
   * under `env` and over the shell's own values, so one call can override
   * what the tool set for every call. */
  baseEnv?: Record<string, string>;
  /** Extra environment variables for this call only. */
  env?: Record<string, string>;
  /**
   * Hard cap on the retained output per stream (characters). Implementations
   * keep the TAIL — the end of a build log is what the model needs — and
   * report the cut through the `truncated` flags. Both backends bound what
   * they retain while the stream runs — the container call because it must
   * not transfer more than it keeps, the host because a command that prints
   * without bound must not take the server's memory with it — and both
   * honour this cap the same way, so the tool's own truncation and spill
   * logic behaves identically on top of them.
   */
  maxOutputChars: number;
}

/** The outcome of one command, already decoded. */
export interface ShellRunResult {
  /** The exit code, or undefined when the process died without one. */
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  /** True when stdout was cut to the retained tail by the runner's cap. */
  stdoutTruncated: boolean;
  /** True when stderr was cut to the retained tail by the runner's cap. */
  stderrTruncated: boolean;
  /** Wall-clock time the call took, measured by the runner. */
  durationMs: number;
  /** True when the command outlived its timeout and was killed. */
  timedOut: boolean;
  /**
   * True when the command left a descendant holding its output streams, so
   * what it wrote afterwards was not observed. The host can hit this (a
   * `server &`); the container call cannot, because its pipes close with the
   * request, so it always reports false.
   */
  orphanedOutput: boolean;
}

/** The raw output cap a runner is asked for: large enough that the tool's
 * own 64 KiB cap and its spill note are what the model always hits first,
 * and small enough that a runaway command cannot exhaust memory. */
export const MAX_RAW_COMMAND_OUTPUT = 4 * 1024 * 1024;
