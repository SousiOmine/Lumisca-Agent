/**
 * Child processes on Bun, in the two shapes the app uses: one command to
 * completion (text or bytes), and one child left running with its pipes.
 *
 * The options are Bun's, not a compatibility layer: `env` is the child's
 * whole environment, `stdin`/`stdout`/`stderr` are Bun's names, and a
 * program that cannot be started throws the same error Bun.spawn does.
 */

import net from "node:net";

/** One stream of a child: Bun's three modes. */
export type Stdio = "pipe" | "ignore" | "inherit";

/** Reads one variable from this process's environment. */
export interface EnvironmentReader {
  get(key: string): string | undefined;
}

/** Reads and removes variables, for the startup capture. */
export interface EnvironmentStore extends EnvironmentReader {
  delete(key: string): void;
}

/** The real environment, as the injectable reads take it. */
export const processEnvironment: EnvironmentStore = {
  get: (key) => process.env[key],
  delete: (key) => {
    delete process.env[key];
  },
};

export interface SpawnOptions {
  cwd?: string;
  /** The child's whole environment. Omitted: a snapshot of this process's
   * environment (see {@link inheritedEnv}). */
  env?: Record<string, string>;
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
  /** Aborting kills the child. */
  signal?: AbortSignal;
}

/** One finished command's output. */
export interface ProcessOutput {
  code: number;
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Start a child and leave it running. Throws when the program cannot be
 * found, which is what a caller reports as "not installed". */
export function spawnProcess(
  command: readonly string[],
  options: SpawnOptions = {},
): Bun.Subprocess {
  return Bun.spawn([...command], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // Bun's default is the environment captured at process start, not the
    // current one; a test (or a launcher) that just set a variable must see
    // it, so the current environment is always spelled out.
    env: options.env ?? inheritedEnv(),
    stdin: options.stdin ?? "ignore",
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/** Run one command to completion. Both pipes are collected; a program that
 * cannot be started throws. */
export async function runProcess(
  command: readonly string[],
  options: Omit<SpawnOptions, "stdout" | "stderr"> = {},
): Promise<ProcessOutput> {
  const child = spawnProcess(command, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    readAll(child.stdout),
    readAll(child.stderr),
    child.exited,
  ]);
  return { code, success: code === 0, stdout, stderr };
}

/** Run one command to completion, synchronously. For the small probes the
 * startup path cannot make async (shell detection, `chcp`). */
export function runProcessSync(
  command: readonly string[],
  options: Omit<SpawnOptions, "stdout" | "stderr"> = {},
): ProcessOutput {
  const result = Bun.spawnSync([...command], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? inheritedEnv(),
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** The child's whole environment, this process's included. Use when adding
 * a few variables: Bun replaces the environment rather than merging it. */
export function inheritedEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Open a unix socket, for the pre-flight checks that only need to know
 * whether something is listening. */
export function connectUnixSocket(path: string): Promise<{ close(): void }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once("connect", () => resolve({ close: () => socket.destroy() }));
    socket.once("error", reject);
  });
}

/** Terminate the process. A declaration returning `never` so the control
 * flow analysis ends a function after it; `process.exit()` is a method
 * call, and TypeScript emits no narrowing after those. */
export function exit(code?: number): never {
  process.exit(code);
}

async function readAll(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (stream === undefined) return new Uint8Array(0);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
