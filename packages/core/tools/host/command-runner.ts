import { errorMessage } from "../../errors.ts";
import {
  type CommandRunner,
  MAX_RAW_COMMAND_OUTPUT,
  type RunOptions,
  type ShellRunResult,
} from "../command-backend.ts";
import { shellCommand } from "./shell.ts";
import { killProcessTree } from "./process-tree.ts";
import { MAX_UTF8_BYTES_PER_CHAR, OutputTail } from "./output-tail.ts";

/** How long the pipes get to flush the last output after the process exits
 * before the call reports what it has (a descendant that keeps a pipe open
 * must not block the report). */
const FINAL_FLUSH_GRACE_MS = 250;
/** Upper bound for a kill to wait for the process to actually die. Mirrors
 * the constant background.ts uses (it lives there because both share it,
 * and this module must not import the background manager). */
const KILL_WAIT_MS = 3000;

/**
 * The host implementation of {@link CommandRunner}: one shell command on
 * this machine, spawned through the detected platform shell (see shell.ts)
 * with both pipes captured.
 *
 * The wait policy is the subtle part and the reason this lives in one class:
 * the command's own EXIT ends the wait — never its pipes' EOF. A process the
 * command leaves behind (a `server &`) inherits the pipes and keeps them open
 * for as long as it lives, and no kill can close a pipe another process
 * holds: waiting for EOF hung this tool, its step and the whole session for
 * good. The exit is bounded by the timeout kill plus a grace for a survivor.
 */
export class HostCommandRunner implements CommandRunner {
  constructor(private readonly baseEnv: Record<string, string> = {}) {}

  async run(command: string, options: RunOptions): Promise<ShellRunResult> {
    const startedAt = performance.now();
    // Per-call env vars override the tool's own values (`baseEnv`), and both
    // override the shell's own (NO_COLOR and friends): a tool set the
    // environment deliberately, so it must win over a cosmetic default.
    const process = shellCommand({
      command,
      cwd: options.cwd,
      baseEnv: this.baseEnv,
      env: { ...options.baseEnv, ...options.env },
    }).spawn();

    // The pipes are read here rather than through child.output(): that call
    // waits for their EOF, and the wait below must not (see the class
    // comment). The readers are held, not the streams, because the call
    // cancels them once it stops waiting. Each pipe keeps its tail only
    // (see OutputTail): a command that prints without bound must not be able
    // to fill this process's memory before the cap below is applied.
    const outTail = new OutputTail(outputBudget(options.maxOutputChars));
    const errTail = new OutputTail(outputBudget(options.maxOutputChars));
    const outReader = process.stdout.getReader();
    const errReader = process.stderr.getReader();
    const readers = [
      drain(outReader, outTail),
      drain(errReader, errTail),
    ];

    // Fire-and-forget: the timeout/abort path must not await the kill (the
    // exit wait below already covers it).
    const kill = () => void killProcessTree(process);
    let timedOut = false;
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutSec * 1000);
    // The two bounds the wait below adds; cleared in `finally` so a call
    // leaves no timer behind.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let flushGiveUp: ReturnType<typeof setTimeout> | undefined;

    try {
      const status = await Promise.race([
        process.status,
        new Promise<undefined>((resolve) => {
          deadline = setTimeout(
            () => resolve(undefined),
            options.timeoutSec * 1000 + KILL_WAIT_MS,
          );
        }),
      ]);
      // The command's last output can still be in flight when it exits: the
      // readers get a grace to flush it (bounded, because the pipes may
      // never close). "Drained" is what tells the two cases apart.
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
        // and an open handle — for as long as that process lives).
        await Promise.all([outReader.cancel(), errReader.cancel()]);
      }
      // Measured from before spawn() to the flushed readers: this is what
      // the agent waited for (shell startup included), not just the child's
      // own runtime.
      const durationMs = Math.round(performance.now() - startedAt);
      const out = cap(outTail, options.maxOutputChars);
      const err = cap(errTail, options.maxOutputChars);
      return {
        exitCode: status?.code,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        durationMs,
        timedOut,
        orphanedOutput: !drained,
      };
    } catch (error) {
      // A spawn-time failure or a pipe error: make sure the tree is dead
      // before surfacing the failure — a stray process would keep running
      // (and hold the pipes) otherwise.
      kill();
      throw new Error(`Could not run the command: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
      clearTimeout(flushGiveUp);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Bytes retained per pipe for a character cap: one UTF-8 character is at
 * most four bytes, so this budget always holds the tail the caller asked
 * for (the cap is defined in characters — see command-backend.ts). */
function outputBudget(maxChars: number): number {
  return Math.max(
    1,
    Math.min(maxChars, MAX_RAW_COMMAND_OUTPUT) * MAX_UTF8_BYTES_PER_CHAR,
  );
}

/** Drain one of the child's pipes into `tail`; resolves at EOF, or when
 * the reader is cancelled — which is how the call stops waiting. */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  tail: OutputTail,
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      tail.push(value);
    }
  } catch {
    // The pipe was closed under us (a kill, or the cancel above): what was
    // read is the output.
  }
}

/** Keep the tail: the end of a build log is what the model needs, and the
 * caller announces the cut itself. */
function cap(
  tail: OutputTail,
  maxChars: number,
): { text: string; truncated: boolean } {
  const text = tail.finish();
  const limit = Math.min(maxChars, MAX_RAW_COMMAND_OUTPUT);
  if (text.length <= limit) {
    return { text, truncated: tail.truncated };
  }
  return { text: text.slice(-limit), truncated: true };
}
