/**
 * The stella VM's implementations of the command ports: `bash` and
 * `async_bash` run inside the machine, never on the host.
 *
 * A foreground command is one `podman exec` running `bash -lc`, so it means
 * what it means to the host runner (a login shell, `/bin/sh`'s replacement in
 * the image) rather than being a second, subtly different dialect. `podman
 * exec` forwards the command's own exit status, so a failing build reports
 * its own code and not podman's.
 *
 * A background command cannot be one call — it must outlive the tool result —
 * so it is started detached inside the machine with its output going to a
 * per-command log file, and the returned handle follows that file and the
 * process's liveness. Killing it targets the process group, so a `npm run
 * dev` does not leave the server behind.
 */
import type {
  BackgroundProcess,
  BackgroundSpawner,
  BackgroundSpawnInput,
} from "../tools/background-backend.ts";
import type {
  CommandRunner,
  RunOptions,
  ShellRunResult,
} from "../tools/command-backend.ts";
import { firstLine } from "../lines.ts";
import { VM_BG_DIR } from "./contract.ts";
import type { VmExec } from "./container.ts";
import { sleep } from "../shared/misc.ts";
import { shellQuote } from "./quote.ts";

/** Bound for starting a background command (the tool must return promptly). */
const SPAWN_TIMEOUT_MS = 30_000;
/** Polling cadence of a background command's log and liveness. */
const POLL_INTERVAL_MS = 250;
/** How much of a background log one poll reads at a time. */
const POLL_MAX_BYTES = 64 * 1024;

/** Where background command logs and pid files live inside the machine. */
const BG_DIR = VM_BG_DIR;

/**
 * The foreground runner: one `bash -lc` inside the machine.
 *
 * Per-call env vars are exported by the shell itself (`env NAME=value …`)
 * rather than passed as `podman exec --env`: the value can contain anything,
 * and one escaping path (shellQuote) is easier to keep right than two.
 */
export class VmCommandRunner implements CommandRunner {
  readonly #exec: VmExec;

  constructor(exec: VmExec) {
    this.#exec = exec;
  }

  async run(command: string, options: RunOptions): Promise<ShellRunResult> {
    const startedAt = performance.now();
    const env = envPrefix({ ...options.baseEnv, ...options.env });
    const result = await this.#exec(
      ["bash", "-lc", `${env}${command}`],
      {
        workdir: options.cwd,
        timeoutMs: Math.max(1, Math.ceil(options.timeoutSec)) * 1000,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        maxOutput: options.maxOutputChars,
        keep: "tail",
      },
    );
    const durationMs = Math.round(performance.now() - startedAt);
    return {
      // `podman exec` reports the command's own exit code; -1 means podman
      // could not start the call at all.
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.truncated,
      stderrTruncated: false,
      durationMs,
      timedOut: result.timedOut,
      // The container call's pipes close with the request, so no descendant
      // can be holding them.
      orphanedOutput: false,
    };
  }
}

/**
 * The background spawner.
 *
 * The command runs under `setsid` in its own session (so a kill reaches every
 * process it started), with its output appended to `<BG_DIR>/<id>.log` and
 * its pid recorded in `<BG_DIR>/<id>.pid`. `spawn` waits only for the start
 * to be confirmed (a few milliseconds), never for output.
 */
export class VmBackgroundSpawner implements BackgroundSpawner {
  readonly #exec: VmExec;
  #seq = 0;

  constructor(exec: VmExec) {
    this.#exec = exec;
  }

  async spawn(input: BackgroundSpawnInput): Promise<BackgroundProcess> {
    const id = `${Date.now().toString(36)}-${++this.#seq}`;
    const log = `${BG_DIR}/${id}.log`;
    const pidFile = `${BG_DIR}/${id}.pid`;
    const script = [
      `mkdir -p ${shellQuote(BG_DIR)}`,
      `: > ${shellQuote(log)}`,
      `cd ${shellQuote(input.cwd)} && ` +
      // `$!` is the setsid child's pid; setsid makes it the group leader, so
      // `kill -<pid>` reaches the whole tree.
      `${envPrefix(input.env)}setsid bash -lc ${shellQuote(input.command)} ` +
      `>> ${shellQuote(log)} 2>&1 & ` +
      `printf '%s' "$!" > ${shellQuote(pidFile)}`,
      `cat ${shellQuote(pidFile)}`,
    ].join("\n");
    const result = await this.#exec(["sh", "-c", script], {
      timeoutMs: SPAWN_TIMEOUT_MS,
      maxOutput: 4096,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not start the background command: ${
          firstLine(result.stderr) || firstLine(result.stdout)
        }`,
      );
    }
    const pid = Number(result.stdout.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(
        `Could not start the background command (it reported no process id: ${
          firstLine(result.stdout)
        })`,
      );
    }

    const exec = this.#exec;
    let killed = false;
    const isAlive = async (): Promise<boolean> => {
      const probe = await this.#exec(
        [
          "sh",
          "-c",
          'pid=$(cat "$1" 2>/dev/null); ' +
          '[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo alive || echo gone',
          "sh",
          pidFile,
        ],
        { timeoutMs: 15_000, maxOutput: 4096 },
      ).catch(() => undefined);
      return probe?.stdout.trim() === "alive";
    };

    return {
      pid,
      output: this.#follow(log, isAlive),
      exited: this.#awaitExit(isAlive),
      async kill() {
        if (killed) return;
        killed = true;
        // TERM then KILL, both addressed to the process group. A command that
        // already exited leaves nothing to signal (the `|| true` absorbs it).
        await exec(
          [
            "sh",
            "-c",
            `kill -TERM -${pid} 2>/dev/null || true; ` +
            `sleep 0.2; kill -KILL -${pid} 2>/dev/null || true`,
          ],
          { timeoutMs: 15_000, maxOutput: 4096 },
        ).catch(() => undefined);
      },
    };
  }

  /**
   * Resolve with the command's exit code once it is gone.
   *
   * The code is not recoverable: the process detached from the `podman exec`
   * that started it, so its status belongs to a call that already ended.
   * Undefined is the honest answer, and the manager's completion reason says
   * "exited" without a code — the log holds whatever the command printed.
   */
  async #awaitExit(
    isAlive: () => Promise<boolean>,
  ): Promise<number | undefined> {
    for (;;) {
      if (!(await isAlive())) return undefined;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Follow the log: emit what was appended since the last poll, and end
   * once the process is gone and the log stopped growing. */
  async *#follow(
    log: string,
    isAlive: () => Promise<boolean>,
  ): AsyncGenerator<Uint8Array> {
    let offset = 0;
    for (;;) {
      const chunk = await this.#readSince(log, offset);
      if (chunk.length > 0) {
        offset += chunk.length;
        yield chunk;
        continue;
      }
      if (!(await isAlive())) {
        // One last read: the command's final output can land between the
        // liveness check and the previous read.
        const rest = await this.#readSince(log, offset);
        if (rest.length > 0) yield rest;
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** The log bytes past `offset`. */
  async #readSince(log: string, offset: number): Promise<Uint8Array> {
    const result = await this.#exec(
      [
        "sh",
        "-c",
        'tail -c +"$2" "$1" 2>/dev/null | head -c "$3"',
        "sh",
        log,
        String(offset + 1),
        String(POLL_MAX_BYTES),
      ],
      { timeoutMs: 15_000, maxOutput: POLL_MAX_BYTES },
    ).catch(() => undefined);
    if (result === undefined || result.exitCode !== 0) return new Uint8Array(0);
    return new TextEncoder().encode(result.stdout);
  }
}

/** The `env NAME='value' …` prefix that carries per-call env vars into the
 * shell that runs the command. Empty when there are none. */
function envPrefix(env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return "";
  return `env ${
    entries.map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ")
  } `;
}
