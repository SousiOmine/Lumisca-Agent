/**
 * The stella virtual machine: a podman container the agent works inside.
 *
 * Only the container's own existence and health are managed here — what the
 * agent does with it (files, shell, screen) lives in the backends that sit on
 * top (vm/fs.ts, vm/shell.ts, vm/screen.ts). State is decided by asking
 * podman every time rather than by a ledger on our side: a container stopped
 * by hand, or removed with `podman rm`, must not leave this application
 * believing the machine is up.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  VM_BUILD_TIMEOUT_MS,
  VM_CONTAINER_NAME,
  VM_CONTAINERFILE_NAME,
  VM_DISPLAY,
  VM_GID,
  VM_IMAGE_NAME,
  VM_MANAGED_LABEL,
  VM_REMOVE_TIMEOUT_MS,
  VM_RUN_TIMEOUT_MS,
  VM_SCREEN_HEIGHT,
  VM_SCREEN_WIDTH,
  VM_STATUS_CACHE_MS,
  VM_STOP_TIMEOUT_MS,
  VM_UID,
  VM_VNC_PORT,
  VM_WORKDIR,
} from "./contract.ts";
import {
  runVmCommand,
  VM_TEXT_OUTPUT_LIMIT,
  type VmCommandBytesResult,
  type VmCommandBytesRunner,
  type VmCommandResult,
  type VmCommandRunner,
} from "./command.ts";

/** Where the machine is, as far as this application can tell. */
export type VmState =
  /** podman is not installed or not runnable here. */
  | "podman_missing"
  /** podman works; the image has never been built. */
  | "image_missing"
  /** The image exists; no container has been created yet. */
  | "container_missing"
  /** The container exists but is not running. */
  | "stopped"
  /** The container is running and answers (`/home/agent` is reachable). */
  | "running";

export interface VmStatus {
  state: VmState;
  /** The host port noVNC's websockify is published on, when known. */
  vncPort: number | null;
  /** Why the machine is unusable, when the state says so. Empty otherwise. */
  reason: string;
}

/** Progress reported while the machine is being prepared. Building takes
 * minutes on a first run, and a silent wait reads as a hang. */
export type VmProgress =
  | { phase: "building_image" }
  | { phase: "creating_container" }
  | { phase: "starting_container" }
  | { phase: "verifying" };

export interface VmManagerOptions {
  /** The directory holding the container's `Containerfile` and `entry.sh`
   * (resolved by the server: a repository checkout and a packaged install
   * keep them in different places). */
  containerDir: string;
  /** Command runner override (tests drive the manager without podman). */
  run?: VmCommandRunner;
  /** Progress sink: called before each preparation step so the UI can say
   * what is happening. */
  onProgress?: (progress: VmProgress) => void;
}

export interface VmManager {
  /** Ask podman where the machine is. Cached briefly (see VM_STATUS_CACHE_MS);
   * `fresh` bypasses the cache after an operation that changed the state. */
  status(options?: { fresh?: boolean }): Promise<VmStatus>;
  /** Bring the machine up, building/creating/starting what is missing.
   * Returns the final status; throws with a readable reason when it could
   * not be reached. */
  start(): Promise<VmStatus>;
  /** Stop the container (`podman stop`). A machine that is already gone is
   * not an error. */
  stop(): Promise<void>;
  /** Throw the machine away and create a fresh one. Everything inside it
   * goes with it — the files the agent was working on live in the container,
   * which is the point of the isolation — so callers confirm with the user
   * first. */
  reset(): Promise<VmStatus>;
  /** The host port noVNC is published on; null when the machine is not
   * running. Read fresh (the port is assigned at creation). */
  vncPort(): Promise<number | null>;
}

/** The podman command prefix every call shares. */
function podman(args: readonly string[]): string[] {
  return ["podman", ...args];
}

export function createVmManager(options: VmManagerOptions): VmManager {
  const run = options.run ?? runVmCommand;
  const containerfilePath = join(
    options.containerDir,
    VM_CONTAINERFILE_NAME,
  );

  let cached: { at: number; status: VmStatus } | null = null;

  const report = (progress: VmProgress) => options.onProgress?.(progress);

  async function status(readFresh = false): Promise<VmStatus> {
    const now = Date.now();
    if (!readFresh && cached !== null && now - cached.at < VM_STATUS_CACHE_MS) {
      return cached.status;
    }
    const result = await readStatus();
    cached = { at: now, status: result };
    return result;
  }

  async function readStatus(): Promise<VmStatus> {
    // `podman --version` is the cheapest proof that podman exists and runs as
    // this user (a rootless setup that is not configured fails here too).
    const version = await run(podman(["--version"]), {
      timeoutMs: 15_000,
      maxOutput: 4096,
    });
    if (version.exitCode !== 0) {
      return {
        state: "podman_missing",
        vncPort: null,
        reason: `podman is not available: ${firstLine(version.stderr)}`,
      };
    }
    const image = await run(podman(["image", "exists", VM_IMAGE_NAME]), {
      timeoutMs: 30_000,
    });
    if (image.exitCode !== 0) {
      return { state: "image_missing", vncPort: null, reason: "" };
    }
    // `container inspect` answers with JSON even for a stopped container;
    // a non-zero exit means there is none.
    const inspect = await run(
      podman([
        "container",
        "inspect",
        "--format",
        "{{.State.Status}} {{.State.Running}}",
        VM_CONTAINER_NAME,
      ]),
      { timeoutMs: 30_000, maxOutput: 4096 },
    );
    if (inspect.exitCode !== 0) {
      return { state: "container_missing", vncPort: null, reason: "" };
    }
    const running = / true\b/.test(inspect.stdout) ||
      inspect.stdout.trim().endsWith(" true");
    if (!running) {
      return { state: "stopped", vncPort: null, reason: "" };
    }
    const port = await readVncPort();
    // Running is not enough: the machine is usable when its workdir answers
    // and the image still matches the contract. A container left running
    // from an older image would otherwise serve calls that fail deep inside
    // a tool.
    const probe = await run(
      podmanExec(["sh", "-c", 'test -d "$1"', "sh", VM_WORKDIR]),
      { timeoutMs: 30_000 },
    );
    if (probe.exitCode !== 0) {
      return {
        state: "stopped",
        vncPort: port,
        reason: `the machine did not answer: ${firstLine(probe.stderr)}`,
      };
    }
    const contract = await verifyContract();
    if (contract !== null) {
      return { state: "stopped", vncPort: port, reason: contract };
    }
    return { state: "running", vncPort: port, reason: "" };
  }

  /** Run a command inside the container. `workdir` is always explicit: podman
   * fails on a missing directory, so callers that use a subdirectory must
   * have created it. */
  function podmanExec(
    command: readonly string[],
    options: {
      workdir?: string;
      interactive?: boolean;
      env?: Record<string, string>;
    } = {},
  ): string[] {
    return podman([
      "exec",
      ...(options.interactive === true ? ["--interactive"] : []),
      ...Object.entries(options.env ?? {}).flatMap((
        [name, value],
      ) => ["--env", `${name}=${value}`]),
      "--workdir",
      options.workdir ?? VM_WORKDIR,
      VM_CONTAINER_NAME,
      ...command,
    ]);
  }

  /** The host port noVNC is published on, read from podman (the port is
   * chosen when the container is created, so it cannot be a constant). */
  async function readVncPort(): Promise<number | null> {
    const result = await run(
      podman([
        "port",
        VM_CONTAINER_NAME,
        `${VM_VNC_PORT}/tcp`,
      ]),
      { timeoutMs: 30_000, maxOutput: 4096 },
    );
    if (result.exitCode !== 0) return null;
    // `127.0.0.1:49153` (IPv4) or `[::1]:49153`; take the last colon.
    const text = result.stdout.trim().split("\n")[0] ?? "";
    const colon = text.lastIndexOf(":");
    if (colon === -1) return null;
    const port = Number(text.slice(colon + 1));
    return Number.isInteger(port) && port > 0 ? port : null;
  }

  /** Check the running container against the contract values. Returns the
   * mismatch as a sentence, or null when everything matches. A drifted image
   * would break screenshots (DISPLAY), file ownership (uid/gid) or the shell
   * (workdir) silently, so start-up refuses it instead. */
  async function verifyContract(): Promise<string | null> {
    const probe = await run(
      podmanExec([
        "sh",
        "-c",
        'printf "%s|%s|%s\\n" "$DISPLAY" "$(id -u)" "$(pwd)"',
      ]),
      { timeoutMs: 30_000, maxOutput: 4096 },
    );
    if (probe.exitCode !== 0) {
      return `the machine did not answer: ${firstLine(probe.stderr)}`;
    }
    const [display, uid, workdir] = probe.stdout.trim().split("|");
    if (display !== VM_DISPLAY) {
      return `the machine's display is ${display}, expected ${VM_DISPLAY}`;
    }
    if (uid !== String(VM_UID)) {
      return `the machine runs as uid ${uid}, expected ${VM_UID}`;
    }
    if (workdir !== VM_WORKDIR) {
      return `the machine's working directory is ${workdir}, expected ${VM_WORKDIR}`;
    }
    // The screen must be the size the agent's coordinates assume.
    const geometry = await run(
      podmanExec(["xdotool", "getdisplaygeometry"]),
      { timeoutMs: 30_000, maxOutput: 4096 },
    );
    if (geometry.exitCode !== 0) {
      return `the machine's screen is not up: ${firstLine(geometry.stderr)}`;
    }
    const [width, height] = geometry.stdout.trim().split(/\s+/);
    if (
      Number(width) !== VM_SCREEN_WIDTH || Number(height) !== VM_SCREEN_HEIGHT
    ) {
      return `the machine's screen is ${width}x${height}, expected ${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT}`;
    }
    return null;
  }

  async function buildImage(): Promise<void> {
    if (!existsSync(containerfilePath)) {
      throw new Error(
        `The machine's image definition is missing: ${containerfilePath}`,
      );
    }
    report({ phase: "building_image" });
    const result = await run(
      podman([
        "build",
        "--tag",
        VM_IMAGE_NAME,
        "--file",
        containerfilePath,
        options.containerDir,
      ]),
      { timeoutMs: VM_BUILD_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not build the machine's image: ${detail(result)}`,
      );
    }
  }

  async function createContainer(): Promise<void> {
    report({ phase: "creating_container" });
    const result = await run(
      podman([
        "run",
        "--detach",
        "--name",
        VM_CONTAINER_NAME,
        "--label",
        VM_MANAGED_LABEL,
        // The container's uid 1000 is mapped onto this host user, so files
        // the agent writes inside are this user's own — and files it must not
        // touch (the host's) are not reachable at all, because nothing is
        // mounted from the host.
        "--userns",
        `keep-id:uid=${VM_UID},gid=${VM_GID}`,
        // The screen bridge, on the host's loopback only.
        "--publish",
        `127.0.0.1::${VM_VNC_PORT}`,
        VM_IMAGE_NAME,
      ]),
      { timeoutMs: VM_RUN_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not create the machine: ${detail(result)}`,
      );
    }
  }

  async function startContainer(): Promise<void> {
    report({ phase: "starting_container" });
    const result = await run(
      podman(["start", VM_CONTAINER_NAME]),
      { timeoutMs: VM_RUN_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not start the machine: ${detail(result)}`);
    }
  }

  /** Whether the container's entry point has finished bringing the screen
   * up. A freshly started container needs a moment; without this the first
   * status check after start would report "stopped" because the screen is
   * not answering yet. */
  async function waitForScreen(): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const probe = await run(
        podmanExec(["xdotool", "getdisplaygeometry"]),
        { timeoutMs: 15_000, maxOutput: 4096 },
      );
      if (probe.exitCode === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `The machine started but its screen did not come up: ${
            firstLine(probe.stderr)
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const manager: VmManager = {
    status: (statusOptions) => status(statusOptions?.fresh === true),

    async start() {
      const before = await status(true);
      switch (before.state) {
        case "podman_missing":
          throw new Error(before.reason);
        case "running":
          return before;
        case "image_missing":
          await buildImage();
          await createContainer();
          break;
        case "container_missing":
          await createContainer();
          break;
        case "stopped":
          if (before.reason !== "") {
            // The container exists but is broken (a drifted image, a dead
            // entry point). Recreating it is the only way forward, and
            // nothing of the agent's work is lost: the home lives inside the
            // container by design.
            report({ phase: "creating_container" });
            await run(podman(["rm", "--force", VM_CONTAINER_NAME]), {
              timeoutMs: VM_REMOVE_TIMEOUT_MS,
            });
            await createContainer();
          } else {
            await startContainer();
          }
          break;
      }
      report({ phase: "verifying" });
      await waitForScreen();
      const after = await status(true);
      if (after.state !== "running") {
        throw new Error(
          after.reason !== ""
            ? after.reason
            : `the machine is not running (state: ${after.state})`,
        );
      }
      return after;
    },

    async stop() {
      const current = await status(true);
      if (current.state === "podman_missing") return;
      if (current.state !== "running" && current.state !== "stopped") return;
      // A machine that is already stopped is not an error: stopping is
      // idempotent, and the app calls it on every shutdown.
      await run(podman(["stop", "--time", "5", VM_CONTAINER_NAME]), {
        timeoutMs: VM_STOP_TIMEOUT_MS,
        maxOutput: VM_TEXT_OUTPUT_LIMIT,
      });
      cached = null;
    },

    async reset() {
      // Nothing of the machine lives on the host (the isolation is the
      // point), so removing the container IS the reset: the next start
      // creates an empty one.
      await run(podman(["rm", "--force", VM_CONTAINER_NAME]), {
        timeoutMs: VM_REMOVE_TIMEOUT_MS,
      });
      cached = null;
      return await manager.start();
    },

    vncPort: async () => {
      const current = await status();
      return current.state === "running" ? current.vncPort : null;
    },
  };
  return manager;
}

/** Run a command inside the machine (the entry point every backend uses). */
export interface VmExec {
  (command: readonly string[], options: VmExecOptions): Promise<VmExecResult>;
}

/** The same seam for a command whose output is binary (a screen capture). */
export interface VmExecBytes {
  (
    command: readonly string[],
    options: VmExecOptions,
  ): Promise<VmExecBytesResult>;
}

export type VmExecBytesResult = VmCommandBytesResult;

export interface VmExecOptions {
  workdir?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: Uint8Array;
  maxOutput?: number;
  keep?: "head" | "tail";
  /** Environment variables for this call only (`podman exec --env`). */
  env?: Record<string, string>;
}

export type VmExecResult = VmCommandResult;

export type { VmCommandBytesResult };

/** First line of a command's error output, for a one-sentence reason. */
function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line === "" ? "(no output)" : line.trim();
}

/** The sentence a failed command contributes: its stderr, else its stdout,
 * else the exit code. */
function detail(result: VmCommandResult): string {
  const text = result.stderr.trim() || result.stdout.trim();
  return text === "" ? `exit code ${result.exitCode}` : firstLine(text);
}

/** Run a command inside the machine, with the container's name and workdir
 * already applied. This is the seam the file/shell/screen backends use; it
 * exists so none of them has to know podman's argument shape. */
export function createVmExec(options: {
  run: VmCommandRunner;
  containerName?: string;
}): VmExec {
  const container = options.containerName ?? VM_CONTAINER_NAME;
  return (command, exec) => {
    return options.run(
      podman([
        "exec",
        ...(exec.stdin === undefined ? [] : ["--interactive"]),
        ...Object.entries(exec.env ?? {}).flatMap((
          [name, value],
        ) => ["--env", `${name}=${value}`]),
        "--workdir",
        exec.workdir ?? VM_WORKDIR,
        container,
        ...command,
      ]),
      {
        timeoutMs: exec.timeoutMs,
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        ...(exec.stdin !== undefined ? { stdin: exec.stdin } : {}),
        ...(exec.maxOutput !== undefined ? { maxOutput: exec.maxOutput } : {}),
        ...(exec.keep !== undefined ? { keep: exec.keep } : {}),
      },
    );
  };
}

/** The byte variant of {@link createVmExec}: the same argument shape, with
 * the output kept as raw bytes (a PNG must not be decoded as text). */
export function createVmExecBytes(options: {
  runBytes: VmCommandBytesRunner;
  containerName?: string;
}): VmExecBytes {
  const container = options.containerName ?? VM_CONTAINER_NAME;
  return (command, exec) => {
    return options.runBytes(
      podman([
        "exec",
        ...(exec.stdin === undefined ? [] : ["--interactive"]),
        ...Object.entries(exec.env ?? {}).flatMap((
          [name, value],
        ) => ["--env", `${name}=${value}`]),
        "--workdir",
        exec.workdir ?? VM_WORKDIR,
        container,
        ...command,
      ]),
      {
        timeoutMs: exec.timeoutMs,
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        ...(exec.stdin !== undefined ? { stdin: exec.stdin } : {}),
        ...(exec.maxOutput !== undefined ? { maxOutput: exec.maxOutput } : {}),
        ...(exec.keep !== undefined ? { keep: exec.keep } : {}),
      },
    );
  };
}

/** The canonical container name, re-exported for the backends. */
export { VM_CONTAINER_NAME };
