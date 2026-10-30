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
