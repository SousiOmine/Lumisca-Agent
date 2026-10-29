import { killProcessTree } from "./process-tree.ts";
import { shellCommand } from "./shell.ts";

/**
 * Where a background command runs.
 *
 * The {@link BackgroundProcessManager} owns everything the model sees — the
 * id, the state machine, the output ring, the completion notification — and
 * asks its spawner for exactly one thing: a running process it can read and
 * kill. That is what keeps the manager's contract identical on the host
 * (this machine, shell.ts) and in the stella VM (`bash -lc` detached inside
 * the container).
 */
export interface BackgroundSpawner {
  /** Start `command` and return its handle. Resolves as soon as the process
   * is running (never waits for output); rejects when it could not be
   * started at all — the command itself failing is not an error here, that
   * is its exit code.
   *
   * Asynchronous because a VM spawn must cross the container boundary to
   * learn the process id; the host spawner resolves immediately. */
  spawn(input: BackgroundSpawnInput): Promise<BackgroundProcess>;
}

export interface BackgroundSpawnInput {
  command: string;
  /** Absolute working directory the command starts in. */
  cwd: string;
  /** Environment of the owning manager (feeds the shell's own env too). */
  baseEnv?: Record<string, string>;
  /** Per-command env vars; they override the manager's. */
  env?: Record<string, string>;
}

/** One running background command. */
export interface BackgroundProcess {
  pid: number;
  /** Raw output chunks in arrival order (stdout and stderr interleaved the
   * way a terminal would show them). Ends when the process and its pipes
   * do. */
  output: AsyncIterable<Uint8Array>;
  /** Resolves with the exit code once the process ends (undefined when it
   * died without one). */
  exited: Promise<number | undefined>;
  /** Kill the whole process tree. Idempotent, and safe to call after the
   * process exited. */
  kill(): Promise<void>;
}

/** The host spawner: a real child process on this machine, with both pipes
 * captured by the manager's reader. */
export class HostBackgroundSpawner implements BackgroundSpawner {
  spawn(input: BackgroundSpawnInput): Promise<BackgroundProcess> {
    const child = shellCommand({
      command: input.command,
      cwd: input.cwd,
      baseEnv: input.baseEnv,
      env: input.env,
    }).spawn();
    return Promise.resolve({
      pid: child.pid,
      output: mergeStreams(child.stdout, child.stderr),
      exited: child.status.then((status) => status.code ?? undefined),
      kill: () => killProcessTree(child),
    });
  }
}

/** Interleave two pipes into one chunk stream: background output is read the
 * way a terminal shows it, with stderr mixed in. Both readers run
 * concurrently and push into one queue, so neither stream can block the
 * other (a command that fills one pipe while nobody reads it would
 * deadlock). The stream ends when both pipes do. */
async function* mergeStreams(
  first: ReadableStream<Uint8Array>,
  second: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const queue: Uint8Array[] = [];
  let done = 0;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    try {
      for await (const chunk of stream) {
        queue.push(chunk);
        notify();
      }
    } catch {
      // A kill closes the pipe under the reader; what arrived is the output.
    } finally {
      done++;
      notify();
    }
  };
  // Fire-and-forget: the loops end with the pipes.
  void pump(first);
  void pump(second);
  while (done < 2 || queue.length > 0) {
    const chunk = queue.shift();
    if (chunk !== undefined) {
      yield chunk;
      continue;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
}
