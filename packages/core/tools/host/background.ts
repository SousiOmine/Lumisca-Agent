/** The host's background spawner: a real child process on this machine,
 * with both pipes captured by the manager's reader. */
import type {
  BackgroundProcess,
  BackgroundSpawner,
  BackgroundSpawnInput,
} from "../background-backend.ts";
import { killProcessTree } from "./process-tree.ts";
import { shellCommand } from "./shell.ts";

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
