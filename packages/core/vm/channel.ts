import { type ChildProcess, runtime } from "../runtime/runtime.ts";

/**
 * An interactive `podman exec`: the program inside the machine keeps both
 * directions open, so the server can answer what it asks and write what it
 * decided, one line at a time.
 *
 * Every other use of the machine is one request to completion (see
 * command.ts). Code execution is the exception it cannot express: a program
 * runs tool calls whose results it needs before it decides the next one, so
 * the exchange has to stay live for the length of the program.
 *
 * The channel talks to the container's standard streams, never to a port:
 * the machine reaches no address of this server (the server listens on the
 * loopback, and the container's network does not route there), and an
 * inbound surface opened for it would be a new way into the host for code
 * the model wrote.
 */

/** Default retained stderr, characters. The console output of a program is
 * what the model reads; the same bound as a foreground command keeps the
 * truncation note familiar. */
export const VM_CHANNEL_STDERR_LIMIT = 64 * 1024;

export interface VmChannelOptions {
  /** Whole exchange. The caller sets this above the program's own limit so
   * the program's `timeout` is the one that reports, not this one. */
  timeoutMs: number;
  /** The run's abort: a stopped turn stops the process. */
  signal?: AbortSignal;
  maxStderrChars?: number;
}

export interface VmChannel {
  /** Write one line (the newline is added) to the program's stdin. */
  write(line: string): Promise<void>;
  /** The next stdout line, or undefined once stdout ended. */
  read(): Promise<string | undefined>;
  /** Everything written to stderr so far, tail-bounded. */
  stderr(): string;
  /** The exit code, or undefined while the program runs. */
  exitCode(): number | undefined;
  /** Stop the program. Idempotent. */
  kill(): void;
}

/** Starts one interactive command. Injected so the tests drive the
 * protocol without podman; production is {@link openVmChannel}. */
export type VmChannelRunner = (
  command: readonly string[],
  options: VmChannelOptions,
) => Promise<VmChannel>;

/** Start a command with both streams connected. Rejects when it cannot be
 * started at all; a command that starts and then fails is the caller's to
 * read from {@link VmChannel.exitCode}. */
export async function openVmChannel(
  command: readonly string[],
  options: VmChannelOptions,
): Promise<VmChannel> {
  let child: ChildProcess;
  try {
    child = new runtime.Command(command[0]!, {
      args: command.slice(1),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    throw new Error(`Could not start the program in the machine: ${error}`);
  }

  const decoder = new TextDecoder();
  const lines: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];
  let ended = false;
  let pending = "";
  let exitCode: number | undefined;
  let stderr = "";
  let killed = false;

  const deliver = (line: string | undefined): boolean => {
    const waiter = waiters.shift();
    if (waiter === undefined) return false;
    waiter(line);
    return true;
  };

  /** End the stream for every reader: the last partial line, then
   * `undefined` for whoever is waiting. Idempotent, because both the pipe
   * closing and the process exiting arrive here.
   *
   * The process exiting is NOT the end by itself: a descendant it left
   * behind inherits the pipe and can hold it open (`sh -c 'sleep 30'`
   * killed by a timeout leaves the sleep running). Without this, the next
   * read would wait for a stream nothing will ever close. */
  const endStream = (): void => {
    if (ended) return;
    ended = true;
    if (pending.length > 0) {
      const last = pending;
      pending = "";
      if (!deliver(last)) lines.push(last);
    }
    while (waiters.length > 0) waiters.shift()?.(undefined);
  };

  void (async () => {
    const reader = child.stdout.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let index = pending.indexOf("\n");
        while (index >= 0) {
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (!deliver(line)) lines.push(line);
          index = pending.indexOf("\n");
        }
      }
    } catch {
      // A killed process tears its pipe down mid-read; the end of the
      // stream is the same answer either way.
    } finally {
      endStream();
    }
  })();

  void (async () => {
    const reader = child.stderr.getReader();
    const cap = options.maxStderrChars ?? VM_CHANNEL_STDERR_LIMIT;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stderr += decoder.decode(value, { stream: true });
        // The tail is what a failure explains itself with; the same rule as
        // a foreground command's output.
        if (stderr.length > cap) stderr = stderr.slice(stderr.length - cap);
      }
    } catch {
      // See above: a killed process tears the pipe down mid-read.
    }
  })();

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (killed) return;
    killed = true;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    // A program blocked on a promise it never resolves can ignore TERM;
    // SIGKILL after a grace period so it cannot outlive the run. The timer
    // is cleared when the process ends, or a finished run would keep the
    // host's event loop awake for three more seconds.
    killTimer = setTimeout(() => {
      if (exitCode !== undefined) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, 3_000);
  };

  const timer = setTimeout(stop, options.timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });

  void child.status.then((status) => {
    exitCode = status.code;
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", stop);
    // The status settles when the process exits; its pipes may still hold
    // buffered lines, and the reader above drains them. A second is long
    // enough for that drain and short enough that a survivor holding the
    // pipe does not leave the next read waiting.
    setTimeout(endStream, 1_000);
  });

  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  const encoder = new TextEncoder();

  return {
    async write(line: string): Promise<void> {
      writer ??= child.stdin.getWriter();
      try {
        await writer.write(encoder.encode(`${line}\n`));
      } catch {
        // The program is gone; the caller learns that from read() ending.
      }
    },
    read(): Promise<string | undefined> {
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) return Promise.resolve(undefined);
      return new Promise((resolve) => waiters.push(resolve));
    },
    stderr(): string {
      return stderr;
    },
    exitCode(): number | undefined {
      return exitCode;
    },
    kill: stop,
  };
}
