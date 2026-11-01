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
import { basename, join } from "node:path";
import { concatBytes } from "../bytes.ts";
import { firstLine } from "../lines.ts";
import {
  VM_BUILD_TIMEOUT_MS,
  VM_CONTAINER_NAME,
  VM_CONTAINERFILE_NAME,
  VM_COPY_TIMEOUT_MS,
  VM_DISPLAY,
  VM_GID,
  VM_IMAGE_DIGEST_LABEL,
  VM_IMAGE_NAME,
  VM_MANAGED_LABEL,
  VM_PROBE_IMAGE,
  VM_REMOVE_TIMEOUT_MS,
  VM_RUN_TIMEOUT_MS,
  VM_SCREEN_HEIGHT,
  VM_SCREEN_WIDTH,
  VM_STATUS_CACHE_MS,
  VM_STOP_TIMEOUT_MS,
  VM_SUDO_PROBE,
  VM_UID,
  VM_USER,
  VM_VNC_PORT,
  VM_WORKDIR,
} from "./contract.ts";
import {
  runVmCommand,
  VM_TEXT_OUTPUT_LIMIT,
  type VmCommandBytesResult,
  type VmCommandBytesRunner,
  type VmCommandOptions,
  type VmCommandResult,
  type VmCommandRunner,
} from "./command.ts";
import { sleep } from "../shared/misc.ts";

/** Where the machine is, as far as this application can tell. */
export type VmState =
  /** podman is not installed here. */
  | "podman_missing"
  /** podman answers, but no container can be created on this host: the
   * sandbox it runs in denies what the runtime must do (a container in a
   * container without the privileges to nest one). `podman --version`
   * succeeds there, so the state is judged by actually asking the runtime. */
  | "podman_unusable"
  /** podman works; the image has never been built. */
  | "image_missing"
  /** The image exists, but was built from container files that have since
   * changed (the Containerfile was edited, or a release shipped a new one).
   * Starting rebuilds it and recreates the container, keeping the agent's
   * home; the old machine is not reused because it is not the machine this
   * installation describes. */
  | "image_stale"
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
  /** Bring the machine up, building/creating/starting what is missing (and
   * rebuilding an image whose container files changed since it was built).
   * Returns the final status; throws with a readable reason when it could
   * not be reached. */
  start(): Promise<VmStatus>;
  /** Stop the container (`podman stop`). A machine that is already gone is
   * not an error. */
  stop(): Promise<void>;

  /** The host port noVNC is published on; null when the machine is not
   * running. Read fresh (the port is assigned at creation). */
  vncPort(): Promise<number | null>;
}

/** The podman command prefix every call shares. */
function podman(args: readonly string[]): string[] {
  return ["podman", ...args];
}

/**
 * SHA-256 over every file in the directory the machine is built from, or null
 * when the directory cannot be read.
 *
 * The whole directory, not only the Containerfile: it COPYs entry.sh, and a
 * changed entry script is as much a different machine as a changed
 * instruction. The name goes in with the bytes, so adding, removing or
 * renaming a file also changes the digest. Exported for the test that proves
 * an edit changes it.
 */
export async function containerFilesDigest(
  containerDir: string,
): Promise<string | null> {
  let names: string[];
  try {
    names = [...Deno.readDirSync(containerDir)]
      .filter((entry) => entry.isFile)
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const name of names) {
    parts.push(encoder.encode(`${name}\u0000`));
    parts.push(await Deno.readFile(join(containerDir, name)));
    parts.push(encoder.encode("\u0000"));
  }
  const digest = await crypto.subtle.digest("SHA-256", concatBytes(parts));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function createVmManager(options: VmManagerOptions): VmManager {
  const run = options.run ?? runVmCommand;
  const containerfilePath = join(
    options.containerDir,
    VM_CONTAINERFILE_NAME,
  );

  let cached: { at: number; status: VmStatus } | null = null;
  /** Whether a usable image was seen by the last status read, so the next one
   * can skip asking podman again. Undefined until a read has answered: a
   * known-absent image is not retried, but a fresh manager always asks. */
  let imagePresent: boolean | undefined = undefined;
  /** Whether this host has proven it can actually start a container (see
   * readStatus). Undefined until asked; a host that cannot is not asked
   * again on every poll. */
  let runtimeUsable: boolean | undefined = undefined;
  /** The in-flight status read. Concurrent callers (the status poll, an open,
   * the screen's port lookup) wait for the same podman calls instead of
   * queueing their own: on a slow link each redundant call is a second the
   * user waits. */
  let inFlight: Promise<VmStatus> | undefined = undefined;

  const report = (progress: VmProgress) => options.onProgress?.(progress);

  /** The digest of the container files as they are on disk now, or null when
   * they cannot be read (a deployment that lost them: the image on disk is
   * then the only definition and must not be rebuilt from nothing). */
  const containerDigest = () => containerFilesDigest(options.containerDir);

  /** The digest recorded in the image's label, or null when the image has no
   * usable record (built before the label existed, which counts as stale). */
  async function imageDigest(): Promise<string | null> {
    const result = await run(
      podman([
        "image",
        "inspect",
        "--format",
        `{{ index .Labels "${VM_IMAGE_DIGEST_LABEL}" }}`,
        VM_IMAGE_NAME,
      ]),
      { timeoutMs: 30_000, maxOutput: 4096 },
    );
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return value === "" || value === "<no value>" ? null : value;
  }

  /** Whether the image still matches the container files on disk. Unknown
   * files (a deployment without them) leave the image alone: there is
   * nothing to rebuild from. */
  async function imageIsStale(): Promise<boolean> {
    const wanted = await containerDigest();
    if (wanted === null) return false;
    return await imageDigest() !== wanted;
  }

  async function status(readFresh = false): Promise<VmStatus> {
    const now = Date.now();
    if (!readFresh && cached !== null && now - cached.at < VM_STATUS_CACHE_MS) {
      return cached.status;
    }
    if (inFlight !== undefined) return await inFlight;
    const read = (async () => {
      try {
        const result = await readStatus();
        cached = { at: Date.now(), status: result };
        return result;
      } finally {
        inFlight = undefined;
      }
    })();
    inFlight = read;
    return await read;
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
    // podman answering says nothing about whether a container can run here:
    // inside a container that is itself sandboxed, `podman --version` is fine
    // and every start fails at the runtime with a kernel path it may not
    // write. The answer is asked once, cheaply, before the mode is offered —
    // the alternative is what this replaced: the mode offered, an image
    // build minutes long, and a failure whose message names /proc/sys.
    if (!runtimeUsable) {
      const probe = await run(
        podman(["run", "--rm", "--network=none", VM_PROBE_IMAGE, "true"]),
        { timeoutMs: 120_000, maxOutput: 8192 },
      );
      if (probe.exitCode !== 0) {
        return {
          state: "podman_unusable",
          vncPort: null,
          reason: firstLine(probe.stderr) || `exit code ${probe.exitCode}`,
        };
      }
      runtimeUsable = true;
    }
    // `image exists` is the expensive half of a cold check and the answer
    // only changes when the image is built (which the caller does itself) or
    // removed by hand. Once an image has been seen it is not asked about
    // again; a container created from it cannot outlive its removal without
    // the inspect below reporting it.
    if (imagePresent !== true) {
      const image = await run(podman(["image", "exists", VM_IMAGE_NAME]), {
        timeoutMs: 30_000,
      });
      if (image.exitCode !== 0) {
        imagePresent = false;
        return { state: "image_missing", vncPort: null, reason: "" };
      }
      imagePresent = true;
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
    // An image built from older container files (the Containerfile was edited,
    // or a release shipped a new one) is not the machine this installation
    // describes. It is judged before the container, because a machine still
    // running on it must be replaced rather than reported as healthy.
    if (await imageIsStale()) {
      return {
        state: "image_stale",
        vncPort: inspect.exitCode === 0 ? await readVncPort() : null,
        reason: "",
      };
    }
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
   * would break screenshots (DISPLAY), file ownership (uid/gid), the shell
   * (workdir) or root inside the machine (sudo) silently, so start-up
   * refuses it instead. */
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
    // The agent's sudo must be passwordless. An image built before the rule
    // existed would leave root reachable only through a prompt nobody can
    // answer, so the machine is refused rather than started into that state.
    const sudo = await run(podmanExec(VM_SUDO_PROBE), {
      timeoutMs: 30_000,
      maxOutput: 4096,
    });
    if (sudo.exitCode !== 0) {
      return `the machine's "${VM_USER}" account cannot run sudo without a ` +
        `password: ${detail(sudo)}`;
    }
    return null;
  }

  async function buildImage(): Promise<void> {
    if (!existsSync(containerfilePath)) {
      throw new Error(
        `The machine's image definition is missing: ${containerfilePath}`,
      );
    }
    const digest = await containerDigest();
    report({ phase: "building_image" });
    const result = await run(
      podman([
        "build",
        "--tag",
        VM_IMAGE_NAME,
        // The definition's digest travels with the image, so the next start
        // can tell whether the image still matches the files on disk.
        ...(digest === null
          ? []
          : ["--label", `${VM_IMAGE_DIGEST_LABEL}=${digest}`]),
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

  /** Create the container from the image, without starting it. Starting is a
   * separate step because a replacement container receives the agent's home
   * before its first process runs (see recreateContainer). */
  async function createContainer(): Promise<void> {
    report({ phase: "creating_container" });
    const result = await run(
      podman([
        "create",
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

  /** Replace the container, keeping the agent's home.
   *
   * The home is the agent's work — the files it wrote, the folders its
   * conversations work in — and it lives inside the container, so recreating
   * the container would otherwise erase it. It travels through a temporary
   * directory (`podman cp`) rather than being mounted, because the machine's
   * isolation is the point: nothing of the host is reachable from inside.
   * Files root wrote (through sudo) come back owned by the agent account —
   * the copy crosses the userns mapping — which is the right owner for
   * anything under the agent's home.
   *
   * `rebuildImage` is what differs between the two callers: a broken container
   * only needs a fresh one from the same image, while a stale image needs the
   * image itself rebuilt first. The home is saved before either starts, and
   * if saving fails the container is left untouched — better a machine that
   * still starts than one whose files are half-moved. */
  async function recreateContainer(
    options: { rebuildImage: boolean },
  ): Promise<void> {
    const home = await Deno.makeTempDir({ prefix: "lumisca-stella-home-" });
    try {
      const present = await run(
        podman(["container", "exists", VM_CONTAINER_NAME]),
        { timeoutMs: 30_000 },
      );
      const keepHome = present.exitCode === 0;
      if (keepHome) {
        // Stop before copying: a running machine keeps writing to its home.
        await run(podman(["stop", "--time", "5", VM_CONTAINER_NAME]), {
          timeoutMs: VM_STOP_TIMEOUT_MS,
          maxOutput: VM_TEXT_OUTPUT_LIMIT,
        });
        const copyOut = await run(
          podman(["cp", `${VM_CONTAINER_NAME}:${VM_WORKDIR}`, home]),
          { timeoutMs: VM_COPY_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
        );
        if (copyOut.exitCode !== 0) {
          throw new Error(
            `Could not save the machine's files before replacing it, so it ` +
              `was left as it was: ${detail(copyOut)}`,
          );
        }
        await run(podman(["rm", "--force", VM_CONTAINER_NAME]), {
          timeoutMs: VM_REMOVE_TIMEOUT_MS,
        });
      }
      if (options.rebuildImage) await buildImage();
      await createContainer();
      if (keepHome) {
        // `podman cp <container>:<home> <dir>` unpacks the home INTO the
        // directory, under its own base name, so the copy back is from
        // `<dir>/agent`.
        const saved = join(home, basename(VM_WORKDIR));
        const copyIn = await run(
          podman([
            "cp",
            `${saved}/.`,
            `${VM_CONTAINER_NAME}:${VM_WORKDIR}/`,
          ]),
          { timeoutMs: VM_COPY_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
        );
        if (copyIn.exitCode !== 0) {
          throw new Error(
            `The machine was replaced but its files could not be put back ` +
              `(they are kept in ${saved}): ${detail(copyIn)}`,
          );
        }
      }
      await startContainer();
    } finally {
      await Deno.remove(home, { recursive: true }).catch(() => {});
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
      await sleep(300);
    }
  }

  const manager: VmManager = {
    status: (statusOptions) => status(statusOptions?.fresh === true),

    async start() {
      const before = await status(true);
      switch (before.state) {
        case "podman_missing":
        case "podman_unusable":
          throw new Error(before.reason);
        case "running":
          return before;
        case "image_missing":
          await buildImage();
          await createContainer();
          await startContainer();
          break;
        case "image_stale":
          // The container files changed under the image. Rebuild it and carry
          // the agent's home across: the files are the agent's work, and a
          // machine built from older instructions is not the machine this
          // installation describes (it may lack anything the definition now
          // grants).
          await recreateContainer({ rebuildImage: true });
          break;
        case "container_missing":
          await createContainer();
          await startContainer();
          break;
        case "stopped":
          if (before.reason !== "") {
            // The container exists but is broken (a drifted image, a dead
            // entry point). Recreating it is the only way forward. Its home
            // is the agent's work, so it is carried into the new container;
            // losing it would make "the machine misbehaved" cost the user
            // everything the agent had done.
            await recreateContainer({ rebuildImage: false });
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
      if (
        current.state === "image_missing" ||
        current.state === "container_missing"
      ) {
        return;
      }
      // Running, stopped, or stale (a container may still be running the
      // image being replaced): stopping is idempotent and the app calls it on
      // every shutdown, so an already stopped machine is not an error.
      await run(podman(["stop", "--time", "5", VM_CONTAINER_NAME]), {
        timeoutMs: VM_STOP_TIMEOUT_MS,
        maxOutput: VM_TEXT_OUTPUT_LIMIT,
      });
      cached = null;
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

/** The sentence a failed command contributes: its stderr, else its stdout,
 * else the exit code. */
function detail(result: VmCommandResult): string {
  const text = result.stderr.trim() || result.stdout.trim();
  return text === "" ? `exit code ${result.exitCode}` : firstLine(text);
}

/** The `podman exec` argv for one call. Both seams build the same command;
 * only how its output comes back (text or bytes) differs. */
function execArgv(
  container: string,
  command: readonly string[],
  exec: VmExecOptions,
): string[] {
  return podman([
    "exec",
    ...(exec.stdin === undefined ? [] : ["--interactive"]),
    ...Object.entries(exec.env ?? {}).flatMap((
      [name, value],
    ) => ["--env", `${name}=${value}`]),
    "--workdir",
    exec.workdir ?? VM_WORKDIR,
    container,
    ...command,
  ]);
}

/** The per-call options both seams pass through. */
function execOptions(exec: VmExecOptions): VmCommandOptions {
  return {
    timeoutMs: exec.timeoutMs,
    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    ...(exec.stdin !== undefined ? { stdin: exec.stdin } : {}),
    ...(exec.maxOutput !== undefined ? { maxOutput: exec.maxOutput } : {}),
    ...(exec.keep !== undefined ? { keep: exec.keep } : {}),
  };
}

/** Run a command inside the machine, with the container's name and workdir
 * already applied. This is the seam the file/shell/screen backends use; it
 * exists so none of them has to know podman's argument shape. */
export function createVmExec(options: {
  run: VmCommandRunner;
  containerName?: string;
}): VmExec {
  const container = options.containerName ?? VM_CONTAINER_NAME;
  return (command, exec) =>
    options.run(execArgv(container, command, exec), execOptions(exec));
}

/** The byte variant of {@link createVmExec}: the same argument shape, with
 * the output kept as raw bytes (a PNG must not be decoded as text). */
export function createVmExecBytes(options: {
  runBytes: VmCommandBytesRunner;
  containerName?: string;
}): VmExecBytes {
  const container = options.containerName ?? VM_CONTAINER_NAME;
  return (command, exec) =>
    options.runBytes(execArgv(container, command, exec), execOptions(exec));
}

/** The canonical container name, re-exported for the backends. */
export { VM_CONTAINER_NAME };
