/**
 * The stella virtual machine: a podman container the agent works inside.
 *
 * One container per stella agent. The host side of this file owns what every
 * machine shares — whether podman runs here, whether the image matches the
 * container files, and the image build itself — and one manager per agent owns
 * that agent's container: its state, its screen port and its desktop.
 *
 * Only the container's own existence and health are managed here — what the
 * agent does with it (files, shell, screen) lives in the backends that sit on
 * top (vm/fs.ts, vm/shell.ts, vm/screen.ts). State is decided by asking
 * podman every time rather than by a ledger on our side: a container stopped
 * by hand, or removed with `podman rm`, must not leave this application
 * believing the machine is up.
 */

import * as fsSync from "node:fs";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { basename, join } from "node:path";
import { concatBytes } from "../bytes.ts";
import { errorMessage } from "../errors.ts";
import { firstLine } from "../lines.ts";
import { createLogger } from "../log.ts";
import { sleep } from "../shared/misc.ts";
import type {
  VmChannel,
  VmChannelOptions,
  VmChannelRunner,
} from "./channel.ts";
import {
  runVmCommand,
  VM_TEXT_OUTPUT_LIMIT,
  type VmCommandBytesResult,
  type VmCommandBytesRunner,
  type VmCommandOptions,
  type VmCommandResult,
  type VmCommandRunner,
} from "./command.ts";
import {
  VM_A11Y_GSETTINGS_KEY,
  VM_A11Y_HELPER,
  VM_AGENT_LABEL,
  VM_BUILD_TIMEOUT_MS,
  VM_CONTAINERFILE_NAME,
  VM_CONTRACT_CACHE_MS,
  VM_COPY_TIMEOUT_MS,
  VM_DBUS_ADDRESS,
  VM_DBUS_SOCKET,
  VM_DESKTOP_SCRIPT,
  VM_DISPLAY,
  VM_GID,
  VM_HOME_VOLUME,
  VM_IMAGE_DIGEST_LABEL,
  VM_IMAGE_NAME,
  VM_LEGACY_CONTAINER_NAME,
  VM_MANAGED_LABEL,
  VM_MEMORY_LIMIT_BYTES,
  VM_MEMORY_SWAP_BYTES,
  VM_PIDS_LIMIT,
  VM_PROBE_IMAGE,
  VM_PROFILE_ROOT,
  VM_REMOVE_TIMEOUT_MS,
  VM_RUN_TIMEOUT_MS,
  VM_SCREEN_HEIGHT,
  VM_SCREEN_WIDTH,
  VM_STATUS_CACHE_MS,
  VM_STOP_TIMEOUT_MS,
  VM_UID,
  VM_USER,
  VM_VNC_PORT,
  VM_VNC_RFB_PORT,
  VM_WORKDIR,
  vmCacheHomeOf,
  vmContainerName,
} from "./contract.ts";

/** Starting a desktop is a cold start of a window manager and a browser, not a
 * command: the first one builds a profile too. */
const VM_DESKTOP_TIMEOUT_MS = 120_000;

const log = createLogger("stella");

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
  /** The image is ready; this agent's container has not been created yet. */
  | "container_missing"
  /** The container exists but is not running. */
  | "stopped"
  /** The container is running and answers (`/home/agent` is reachable). */
  | "running";

/** What is shared by every machine: podman itself and the image. */
export type VmHostState =
  | "podman_missing"
  | "podman_unusable"
  | "image_missing"
  | "image_stale"
  | "ready";

export interface VmStatus {
  state: VmState;
  /** The host port noVNC's websockify is published on, when known. */
  vncPort: number | null;
  /** Why the machine is unusable, when the state says so. Empty otherwise. */
  reason: string;
}

export interface VmHostStatus {
  state: VmHostState;
  reason: string;
}

/** Progress reported while a machine is being prepared. Building takes
 * minutes on a first run, and a silent wait reads as a hang. */
export type VmProgress =
  | { phase: "building_image" }
  | { phase: "creating_container" }
  | { phase: "starting_container" }
  | { phase: "verifying" };

export interface VmHostOptions {
  /** The directory holding the container's `Containerfile` and `entry.sh`
   * (resolved by the server: a repository checkout and a packaged install
   * keep them in different places). */
  containerDir: string;
  /** Command runner override (tests drive the managers without podman). */
  run?: VmCommandRunner;
  /** Progress sink: called before each preparation step so the UI can say
   * what is happening. */
  onProgress?: (progress: VmProgress) => void;
}

/**
 * One `podman container inspect` answer, in the fields the state is decided
 * from.
 *
 * Tab-separated and parsed here rather than asked as one template per field:
 * every `podman` call is a process spawn, and the client polls this status
 * while it watches stella mode. The port mapping and the labels are JSON
 * because podman's Go template exposes them as maps whose fields differ
 * between versions, while the JSON is the same in all of them.
 *
 * `{{.Id}}` and `{{.State.StartedAt}}` together name one INSTANCE of the
 * machine: the contract below is verified once per instance, so a stop and
 * start (or a recreation) is verified again and a running one is not asked
 * again on every poll.
 */
const CONTAINER_FACTS_FORMAT = `{{.Id}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{json .NetworkSettings.Ports}}\t{{.HostConfig.Memory}}\t{{.HostConfig.MemorySwap}}\t{{.HostConfig.PidsLimit}}\t{{json .Config.Labels}}`;

/**
 * The contract probes, in one shell.
 *
 * Every line is `name=value` and a probe that cannot run leaves its own line
 * out, so the reader tells "the value is wrong" from "the machine did not
 * answer" — the two read very differently to a person. They used to be four
 * separate `podman exec` calls (and the screen probe ran twice), which cost
 * ~400 ms of pure process spawning on every status read.
 *
 * `sudo -n` is a false answer rather than a hang when the rule is missing:
 * it never prompts.
 *
 * The last probe asks the machine's desktop helper (`$2`) for the values only
 * it can see — the screen size, the ports, the profile root and this machine's
 * bus and cache paths — and the reader compares that line with what
 * contract.ts says. A helper whose numbering drifted would put the pane on a
 * port nothing listens on, or the semantic tools on another machine's bus.
 */
const CONTRACT_PROBE_SCRIPT = `
printf 'env=%s|%s|%s\\n' "$DISPLAY" "$(id -u)" "$(pwd)"
if geometry=$(xdotool getdisplaygeometry 2>&1); then
  printf 'geometry=%s\\n' "$geometry"
else
  printf 'geometry_error=%s\\n' "$geometry"
fi
if error=$(sudo -n true 2>&1); then
  printf 'sudo=ok\\n'
else
  printf 'sudo_error=%s\\n' "$error"
fi
printf 'dbus=%s\\n' "$DBUS_SESSION_BUS_ADDRESS"
if toolkit=$(gsettings get org.gnome.desktop.interface toolkit-accessibility 2>&1); then
  printf 'toolkit=%s\\n' "$toolkit"
else
  printf 'toolkit_error=%s\\n' "$toolkit"
fi
if error=$(python3 "$1" '{"command":"find","app":"definitely-not-running"}' 2>&1); then
  printf 'helper=%s\\n' "$error"
else
  printf 'helper_error=%s\\n' "$error"
fi
if desktops=$(sh "$2" contract 2>&1); then
  printf 'desktop=%s\\n' "$desktops"
else
  printf 'desktop_error=%s\\n' "$desktops"
fi
`;

/** What one inspect answered about the container. */
interface ContainerFacts {
  /** The container's own id and when its current run began: together they
   * name the instance whose contract was verified. */
  id: string;
  startedAt: string;
  /** `podman`'s status word; `running` is the only one the machine can serve
   * calls in. */
  status: string;
  /** The host ports the machine publishes, by container port. */
  ports: Record<string, unknown>;
  /** The screen's host port, when there is one. */
  vncPort: number | null;
  /** The agent the container was created for (VM_AGENT_LABEL), or "" when the
   * label is missing. Compared with the agent whose machine asked, so a
   * container reused by hand is replaced rather than driven as somebody
   * else's. */
  agent: string;
  /** The ceilings the container was created with, as podman printed them: two
   * byte counts and a process count. Strings because the answer is compared
   * with what this file asks for and printed back when it differs — a
   * container created without them reports `0`, and a version of podman that
   * answers something else must be reported rather than turned into NaN. */
  memory: string;
  memorySwap: string;
  pidsLimit: string;
}

/** The published host port of the machine's screen, out of the inspect
 * answer's port mapping (`{"6080/tcp":[{"HostIp":"127.0.0.1",
 * "HostPort":"35483"}]}`). */
function vncPortOf(ports: Record<string, unknown>): number | null {
  const bindings = ports[`${VM_VNC_PORT}/tcp`];
  if (!Array.isArray(bindings)) return null;
  for (const binding of bindings) {
    if (typeof binding !== "object" || binding === null) continue;
    const port = Number((binding as { HostPort?: unknown }).HostPort);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return null;
}

/** The sentence a machine whose cgroup has no ceilings contributes, or null
 * when it has the ones this file asks for.
 *
 * A container created without the ceilings is not the machine this
 * installation describes: it would run the same tools with nothing bounding a
 * runaway process, which is the failure they exist to prevent. Reporting it
 * as drift is enough — `start()` replaces such a container, and the agent's
 * home is on its volume, so nothing of the agent's work is lost by that.
 */
function limitsMismatch(facts: ContainerFacts): string | null {
  if (facts.memory !== String(VM_MEMORY_LIMIT_BYTES)) {
    return (
      `the machine's memory ceiling is ${facts.memory} bytes, expected ` +
      `${VM_MEMORY_LIMIT_BYTES}`
    );
  }
  if (facts.memorySwap !== String(VM_MEMORY_SWAP_BYTES)) {
    return (
      `the machine's swap ceiling is ${facts.memorySwap} bytes, expected ` +
      `${VM_MEMORY_SWAP_BYTES}`
    );
  }
  if (facts.pidsLimit !== String(VM_PIDS_LIMIT)) {
    return (
      `the machine's process ceiling is ${facts.pidsLimit}, expected ` +
      `${VM_PIDS_LIMIT}`
    );
  }
  return null;
}

/** What every agent's machine shares. Created once by the server. */
export interface VmHost {
  /** Whether podman runs here and whether the image matches the container
   * files. Cached briefly (see VM_STATUS_CACHE_MS); `fresh` bypasses the
   * cache after an operation that changed the state. */
  status(options?: { fresh?: boolean }): Promise<VmHostStatus>;
  /** Build the image when it is missing or stale, and do nothing when it is
   * current. Concurrent callers share one build. */
  ensureImage(): Promise<void>;
  /** One agent's machine. The same agent always gets the same manager. */
  machine(agentId: string): VmManager;
  /** Stop every machine this host has seen (app shutdown). A machine nobody
   * opened in this process is not touched: another installation may be using
   * it. */
  stopAll(): Promise<void>;
  /** Remove the single container the per-agent machines replaced, keeping its
   * home volume. Does nothing when there is none. Called by the first machine
   * start, not when the host is attached. */
  retireLegacy(): Promise<void>;
  /** Whether an image build is in flight (the client says "preparing"). */
  readonly building: boolean;
}

/** One agent's machine. */
export interface VmManager {
  /** Ask podman where the machine is. Cached briefly (see VM_STATUS_CACHE_MS);
   * `fresh` bypasses the cache after an operation that changed the state. */
  status(options?: { fresh?: boolean }): Promise<VmStatus>;
  /** Bring the machine up, creating the container when it is missing (the
   * image is the host's job). Returns the final status; throws with a
   * readable reason when it could not be reached. */
  start(): Promise<VmStatus>;
  /** Stop the container (`podman stop`). A machine that is already gone is
   * not an error. */
  stop(): Promise<void>;
  /** Remove the container (`podman rm --force`), for an agent that was
   * deleted. The home volume stays. */
  remove(): Promise<void>;

  /** The host port the machine's screen is published on; null when the
   * machine is not running. Read fresh (the host port is assigned at
   * creation). */
  vncPort(): Promise<number | null>;

  /** Start the desktop (window manager, a browser with this agent's own
   * profile, and the VNC bridge), idempotently. The container must be
   * running; a machine that was restarted answers without starting a second
   * browser. */
  startDesktop(): Promise<void>;

  /** Stop the desktop's browser and bridge. Its X server stays: the screen is
   * part of the machine's contract. */
  stopDesktop(): Promise<void>;
}

/** The podman command prefix every call shares. */
function podman(args: readonly string[]): string[] {
  return ["podman", ...args];
}

/**
 * SHA-256 over every file in the directory the machine is built from, or null
 * when the directory cannot be read.
 *
 * The whole directory, not only the Containerfile: it COPYs entry.sh and the
 * accessibility helper, and a changed helper is as much a different machine as
 * a changed instruction. Subdirectories are walked too, and a file's path
 * relative to the directory goes in with the bytes, so adding, removing,
 * renaming or moving a file also changes the digest. Exported for the test
 * that proves an edit changes it.
 */
export async function containerFilesDigest(
  containerDir: string,
): Promise<string | null> {
  let files: { path: string; bytes: Uint8Array }[];
  try {
    files = await readContainerFiles(containerDir);
  } catch {
    return null;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const file of files) {
    parts.push(encoder.encode(`${file.path}\u0000`));
    parts.push(file.bytes);
    parts.push(encoder.encode("\u0000"));
  }
  const digest = await crypto.subtle.digest("SHA-256", concatBytes(parts));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Every file under the container directory, keyed by its relative path with
 * "/" separators. */
async function readContainerFiles(
  dir: string,
  prefix = "",
): Promise<{ path: string; bytes: Uint8Array }[]> {
  const out: { path: string; bytes: Uint8Array }[] = [];
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      out.push(
        ...(await readContainerFiles(join(dir, entry.name), `${path}/`)),
      );
    } else if (entry.isFile()) {
      out.push({ path, bytes: await fsp.readFile(join(dir, entry.name)) });
    }
  }
  return out;
}

export function createVmHost(options: VmHostOptions): VmHost {
  const run = options.run ?? runVmCommand;
  const containerfilePath = join(options.containerDir, VM_CONTAINERFILE_NAME);

  /** Whether `podman --version` has answered successfully. Its answer cannot
   * change while the process runs, and asking it on every status read was one
   * spawn of the three a poll used to cost. A failure is not remembered (see
   * readHostStatus): installing podman must take effect without a restart. */
  let podmanPresent = false;
  /** Whether this host has proven it can actually start a container (see
   * readHostStatus). Undefined until asked; a host that cannot is not asked
   * again on every poll. */
  let runtimeUsable: boolean | undefined;
  /** Whether a usable image was seen by the last status read, so the next one
   * can skip asking podman again. Undefined until a read has answered: a
   * known-absent image is not retried, but a fresh host always asks. */
  let imagePresent: boolean | undefined;
  /** The digest recorded in the image's label, or null when the image has no
   * usable record (built before the label existed, which counts as stale). */
  let imageDigestCache: { value: string | null } | undefined;
  /** The in-flight image build, shared by every machine that asks for one. */
  let buildInFlight: Promise<void> | undefined;
  /** The last host verdict, cached for VM_STATUS_CACHE_MS. */
  let cached: { at: number; status: VmHostStatus } | null = null;
  /** The in-flight host read. Concurrent callers (a poll, several machines
   * starting at once) wait for the same podman calls. */
  let inFlight: Promise<VmHostStatus> | undefined;
  /** One manager per agent, so a status cache and a contract pass belong to
   * the container they were made about. */
  const machines = new Map<string, VmManager>();

  const report = (progress: VmProgress) => options.onProgress?.(progress);

  /** The digest of the container files as they are on disk now, or null when
   * they cannot be read (a deployment that lost them: the image on disk is
   * then the only definition and must not be rebuilt from nothing). */
  const containerDigest = () => containerFilesDigest(options.containerDir);

  /** The digest recorded in the image's label, or null when the image has no
   * usable record.
   *
   * The answer is kept for the life of this host: a label only changes when
   * the image is rebuilt, and a rebuild is something this host does itself
   * (see buildImage, which forgets the cached value). Asking podman again on
   * every status read was a process spawn per poll for an answer that could
   * not have moved. */
  async function imageDigest(): Promise<string | null> {
    if (imageDigestCache !== undefined) return imageDigestCache.value;
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
    const digest = value === "" || value === "<no value>" ? null : value;
    imageDigestCache = { value: digest };
    return digest;
  }

  /** Whether the image still matches the container files on disk. Unknown
   * files (a deployment without them) leave the image alone: there is nothing
   * to rebuild from.
   *
   * The files' digest is read from disk on every check, and the label from
   * podman: they are compared together, so neither can be reused alone. */
  async function imageIsStale(): Promise<boolean> {
    const wanted = await containerDigest();
    if (wanted === null) return false;
    return (await imageDigest()) !== wanted;
  }

  async function hostStatus(readFresh = false): Promise<VmHostStatus> {
    const now = Date.now();
    if (!readFresh && cached !== null && now - cached.at < VM_STATUS_CACHE_MS) {
      return cached.status;
    }
    if (inFlight !== undefined) return await inFlight;
    const read = (async () => {
      try {
        const result = await readHostStatus();
        cached = { at: Date.now(), status: result };
        return result;
      } finally {
        inFlight = undefined;
      }
    })();
    inFlight = read;
    return await read;
  }

  async function readHostStatus(): Promise<VmHostStatus> {
    // `podman --version` is the cheapest proof that podman exists and runs as
    // this user (a rootless setup that is not configured fails here too). A
    // SUCCESS is remembered — podman does not uninstall itself mid-run, and
    // every `podman` call is a spawn the watching client waits through — while
    // a failure is asked again on the next read, because installing podman
    // must take effect without a restart. It is not inferred from a failed
    // inspect: guessing "podman is missing" out of an error message would
    // report a broken installation as an uninstalled one.
    if (!podmanPresent) {
      const version = await run(podman(["--version"]), {
        timeoutMs: 15_000,
        maxOutput: 4096,
      });
      if (version.exitCode !== 0) {
        return {
          state: "podman_missing",
          reason: `podman is not available: ${firstLine(version.stderr)}`,
        };
      }
      podmanPresent = true;
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
          reason: firstLine(probe.stderr) || `exit code ${probe.exitCode}`,
        };
      }
      runtimeUsable = true;
    }
    // `image exists` is the expensive half of a cold check and the answer only
    // changes when the image is built (which the caller does itself) or
    // removed by hand. Once an image has been seen it is not asked about
    // again; a container created from it cannot outlive its removal without
    // the inspect below reporting it.
    if (imagePresent !== true) {
      const image = await run(podman(["image", "exists", VM_IMAGE_NAME]), {
        timeoutMs: 30_000,
      });
      if (image.exitCode !== 0) {
        imagePresent = false;
        return { state: "image_missing", reason: "" };
      }
      imagePresent = true;
    }
    // An image built from older container files (the Containerfile was edited,
    // or a release shipped a new one) is not the machine this installation
    // describes. It is judged before the container, because a machine still
    // running on it must be replaced rather than reported as healthy.
    if (await imageIsStale()) {
      return { state: "image_stale", reason: "" };
    }
    return { state: "ready", reason: "" };
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
      throw new Error(`Could not build the machine's image: ${detail(result)}`);
    }
    // The image the label belonged to is gone: the next read must ask again
    // rather than compare against the build that was just replaced.
    imageDigestCache = undefined;
    imagePresent = true;
    cached = null;
  }

  async function ensureImage(): Promise<void> {
    if (buildInFlight !== undefined) return await buildInFlight;
    const state = await hostStatus(true);
    switch (state.state) {
      case "podman_missing":
      case "podman_unusable":
        throw new Error(state.reason);
      case "image_missing":
      case "image_stale": {
        const build = buildImage().finally(() => {
          buildInFlight = undefined;
        });
        buildInFlight = build;
        await build;
        return;
      }
      case "ready":
        return;
    }
  }

  /** One `podman container inspect`: the state, the instance it belongs to,
   * the screen's published port, the ceilings and the agent label, in one
   * call. Undefined when there is no such container (a non-zero exit, unlike
   * a stopped one). */
  async function readContainerFacts(
    name: string,
  ): Promise<ContainerFacts | undefined> {
    const result = await run(
      podman([
        "container",
        "inspect",
        "--format",
        CONTAINER_FACTS_FORMAT,
        name,
      ]),
      { timeoutMs: 30_000, maxOutput: 8192 },
    );
    if (result.exitCode !== 0) return undefined;
    const line = result.stdout.trim().split("\n")[0] ?? "";
    const [
      id,
      status,
      startedAt,
      ports,
      memory,
      memorySwap,
      pidsLimit,
      labels,
    ] = line.split("\t");
    if (id === undefined || status === undefined) return undefined;
    let published: Record<string, unknown> = {};
    try {
      published = JSON.parse(ports ?? "{}") as Record<string, unknown>;
    } catch {
      // An answer without a readable mapping is a machine whose screen cannot
      // be reached; the status is still worth reporting.
    }
    let named: Record<string, unknown> = {};
    try {
      named = JSON.parse(labels ?? "{}") as Record<string, unknown>;
    } catch {
      // An answer without readable labels is a container whose owner cannot be
      // proven; the caller replaces it.
    }
    const agent = named[VM_AGENT_LABEL];
    return {
      id,
      startedAt: startedAt ?? "",
      status,
      ports: published,
      vncPort: vncPortOf(published),
      agent: typeof agent === "string" ? agent : "",
      memory: memory ?? "",
      memorySwap: memorySwap ?? "",
      pidsLimit: pidsLimit ?? "",
    };
  }

  /** The contract pass of each agent's current instance (see contractOf). */
  const verifiedOf = new Map<string, { instance: string; at: number }>();

  /** Verify one instance of one machine, at most once per
   * VM_CONTRACT_CACHE_MS.
   *
   * The contract values (display, uid, workdir, screen size, sudo, the session
   * bus, the accessibility switch, the helper and the desktop helper's
   * numbering) are proven against the RUNNING container. Asking again on every
   * status read was what made selecting a stella agent cost eighteen `podman`
   * spawns — the client polls the status while it watches — so a PASS is kept
   * for the instance it was made about: `<container id>/<started at>` changes
   * when the container is recreated or restarted, and an image that drifted
   * was already rejected as stale before this point.
   *
   * A mismatch is not remembered: it is re-derived on every read, because the
   * ordinary one is a machine that has not finished booting ("the screen is
   * not up") and caching that would report a working machine as broken. A
   * pass expires as well, so a screen that died inside a running container is
   * noticed instead of being vouched for forever. */
  async function contractOf(
    facts: ContainerFacts,
    agentId: string,
  ): Promise<string | null> {
    const instance = `${facts.id}/${facts.startedAt}`;
    const verified = verifiedOf.get(agentId);
    if (
      verified?.instance === instance &&
      Date.now() - verified.at < VM_CONTRACT_CACHE_MS
    ) {
      return null;
    }
    const mismatch = await verifyContract(agentId);
    if (mismatch === null) {
      verifiedOf.set(agentId, { instance, at: Date.now() });
    }
    return mismatch;
  }

  /** Check the running container against the contract values. Returns the
   * mismatch as a sentence, or null when everything matches. A drifted image
   * would break screenshots (DISPLAY), file ownership (uid/gid), the shell
   * (workdir), root inside the machine (sudo) or the semantic tools (the
   * session bus, the accessibility setting, the helper) silently, so start-up
   * refuses it instead.
   *
   * One `podman exec`, not four: the values are printed by a single shell,
   * which also answers whether the screen is up, whether sudo works without a
   * password, whether the accessibility bus is where the helpers expect it,
   * whether the helper itself runs, and whether the desktop helper's values
   * match this file. Each of those used to be its own spawn. */
  async function verifyContract(agentId: string): Promise<string | null> {
    const name = vmContainerName(agentId);
    const result = await run(
      podmanExec(name, [
        "sh",
        "-c",
        CONTRACT_PROBE_SCRIPT,
        "sh",
        VM_A11Y_HELPER,
        VM_DESKTOP_SCRIPT,
      ]),
      { timeoutMs: 60_000, maxOutput: 8192 },
    );
    // Each line is `name=value`; a probe that could not run leaves its line
    // out, which is reported as "did not answer" rather than as an empty
    // value that happens to differ.
    const fields = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const at = line.indexOf("=");
      if (at !== -1) fields.set(line.slice(0, at), line.slice(at + 1));
    }
    if (!fields.has("env")) {
      return `the machine did not answer: ${
        firstLine(result.stderr) || firstLine(result.stdout)
      }`;
    }
    const [display, uid, workdir] = fields.get("env")!.split("|");
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
    const geometry = fields.get("geometry");
    if (geometry === undefined) {
      return `the machine's screen is not up: ${firstLine(
        fields.get("geometry_error") ?? "",
      )}`;
    }
    const [width, height] = geometry.split(/\s+/);
    if (
      Number(width) !== VM_SCREEN_WIDTH ||
      Number(height) !== VM_SCREEN_HEIGHT
    ) {
      return `the machine's screen is ${width}x${height}, expected ${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT}`;
    }
    // The agent's sudo must be passwordless. An image built before the rule
    // existed would leave root reachable only through a prompt nobody can
    // answer, so the machine is refused rather than started into that state.
    if (!fields.has("sudo")) {
      return (
        `the machine's "${VM_USER}" account cannot run sudo without a ` +
        `password: ${firstLine(fields.get("sudo_error") ?? "")}`
      );
    }
    // The semantic tools (vm_find / vm_do / vm_wait) read a machine's widgets
    // through its session bus, and only see an application that was started
    // with accessibility on. Each failure looks like something else — a find
    // that answers "no such application", an app whose web area is empty — so
    // the machine is refused at start-up instead of at the first tool call.
    const bus = fields.get("dbus");
    if (bus !== VM_DBUS_ADDRESS) {
      return (
        `the machine's session bus is ${bus || "(unset)"}, expected ` +
        `${VM_DBUS_ADDRESS}: the semantic tools could not reach it`
      );
    }
    const toolkit = fields.get("toolkit");
    if (toolkit === undefined) {
      return (
        `the machine cannot read its accessibility setting: ` +
        `${firstLine(fields.get("toolkit_error") ?? "")}`
      );
    }
    if (toolkit.trim() !== "true") {
      return (
        `the machine's ${VM_A11Y_GSETTINGS_KEY} is ` +
        `${toolkit.trim() || "(unset)"}, expected true: applications started ` +
        "without it never appear on the accessibility bus"
      );
    }
    if (!fields.has("helper")) {
      return (
        `the machine's accessibility helper did not run: ` +
        `${firstLine(fields.get("helper_error") ?? "")}`
      );
    }
    // The desktop helper answers for this machine's desktop. Its line is
    // compared verbatim: every value on it is one the server also writes
    // down, and a difference would show up later as a pane that cannot
    // connect or a tool that reads the wrong screen.
    const desktops = fields.get("desktop");
    if (desktops === undefined) {
      return (
        `the machine's desktop helper did not answer: ` +
        `${firstLine(fields.get("desktop_error") ?? "")}`
      );
    }
    const expectedDesktops =
      `screen=${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT} vnc=${VM_VNC_RFB_PORT} ` +
      `websockify=${VM_VNC_PORT} profile=${VM_PROFILE_ROOT} ` +
      `bus=${VM_DBUS_SOCKET} cache=${vmCacheHomeOf(agentId)}`;
    if (desktops !== expectedDesktops) {
      return (
        `the machine's desktop is "${desktops}", expected ` +
        `"${expectedDesktops}"`
      );
    }
    return null;
  }

  /** The `podman exec` argv for a command inside one machine. */
  function podmanExec(
    name: string,
    command: readonly string[],
    exec: {
      workdir?: string;
      interactive?: boolean;
      env?: Record<string, string>;
    } = {},
  ): string[] {
    return podman([
      "exec",
      ...(exec.interactive === true ? ["--interactive"] : []),
      ...Object.entries(exec.env ?? {}).flatMap(([name, value]) => [
        "--env",
        `${name}=${value}`,
      ]),
      "--workdir",
      exec.workdir ?? VM_WORKDIR,
      name,
      ...command,
    ]);
  }

  async function containerExists(name: string): Promise<boolean> {
    const present = await run(podman(["container", "exists", name]), {
      timeoutMs: 30_000,
    });
    return present.exitCode === 0;
  }

  async function stopContainer(name: string): Promise<void> {
    await run(podman(["stop", "--time", "5", name]), {
      timeoutMs: VM_STOP_TIMEOUT_MS,
      maxOutput: VM_TEXT_OUTPUT_LIMIT,
    });
  }

  async function removeContainer(name: string): Promise<void> {
    const removed = await run(podman(["rm", "--force", name]), {
      timeoutMs: VM_REMOVE_TIMEOUT_MS,
    });
    if (removed.exitCode !== 0) {
      throw new Error(`Could not replace the machine: ${detail(removed)}`);
    }
  }

  /** Create one agent's container from the image, without starting it. */
  async function createContainer(agentId: string): Promise<void> {
    report({ phase: "creating_container" });
    const name = vmContainerName(agentId);
    const result = await run(
      podman([
        "create",
        "--name",
        name,
        "--label",
        VM_MANAGED_LABEL,
        // The agent this machine serves. Read back with the container's facts
        // and compared before anything runs inside it, so a container renamed
        // or reused by hand is replaced instead of being driven as somebody
        // else's machine.
        "--label",
        `${VM_AGENT_LABEL}=${agentId}`,
        // A machine that dies by itself (a crashed X server, a browser the
        // kernel killed) has to come back without anyone asking: nothing
        // polls the container, and the only paths that start it are a prompt,
        // a tool call and the screen. `unless-stopped` is the one policy that
        // does not resurrect a machine `podman stop` ended on purpose — that
        // is how idle sleep and the app's own shutdown keep it down.
        "--restart",
        "unless-stopped",
        // Ceilings on what the machine may consume. They put the failure
        // inside the machine: a runaway browser or build is OOM-killed or
        // refused a process there, where the agent sees the error, instead of
        // taking memory or process slots the host's own programs need. The
        // values and why they are those numbers are in contract.ts.
        "--memory",
        String(VM_MEMORY_LIMIT_BYTES),
        "--memory-swap",
        String(VM_MEMORY_SWAP_BYTES),
        "--pids-limit",
        String(VM_PIDS_LIMIT),
        // The container's uid 1000 is mapped onto this host user, so files
        // the agent writes inside are this user's own — and files it must not
        // touch (the host's) are not reachable at all, because nothing is
        // mounted from the host.
        "--userns",
        `keep-id:uid=${VM_UID},gid=${VM_GID}`,
        // The screen bridge, on the host's loopback only. The host port is
        // assigned at creation and read back by `vncPort`.
        "--publish",
        `127.0.0.1::${VM_VNC_PORT}`,
        // The agent's home lives on a named volume, not in the container's
        // own writable layer: the container is recreated by a release, by a
        // sleep it did not survive, or by deleting the agent, and the files
        // the agent wrote must not go with it. Every machine mounts the same
        // volume, so the home is one home (see VM_HOME_VOLUME).
        "--volume",
        `${VM_HOME_VOLUME}:${VM_WORKDIR}`,
        // The cache AT-SPI and Chromium write. It is per agent because the
        // display it is keyed by is the same in every machine and the home is
        // shared (see vmCacheHomeOf).
        "--env",
        `XDG_CACHE_HOME=${vmCacheHomeOf(agentId)}`,
        VM_IMAGE_NAME,
      ]),
      { timeoutMs: VM_RUN_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not create the machine: ${detail(result)}`);
    }
  }

  /** Replace one agent's container, keeping its home volume. */
  async function recreateContainer(agentId: string): Promise<void> {
    const name = vmContainerName(agentId);
    // Stopping first, not removing: `podman rm` on a running container would
    // be `--force` (a kill), and the volume's files are written by processes
    // the machine is still running.
    if (await containerExists(name)) {
      await stopContainer(name);
      await removeContainer(name);
    }
    await createContainer(agentId);
    await startContainer(name);
  }

  async function startContainer(name: string): Promise<void> {
    report({ phase: "starting_container" });
    const result = await run(podman(["start", name]), {
      timeoutMs: VM_RUN_TIMEOUT_MS,
      maxOutput: VM_TEXT_OUTPUT_LIMIT,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not start the machine: ${detail(result)}`);
    }
  }

  /** Whether the container's entry point has finished bringing the screen up.
   * A freshly started container needs a moment; without this the first status
   * check after start would report "stopped" because the screen is not
   * answering yet. */
  async function waitForScreen(name: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const probe = await run(
        podmanExec(name, ["xdotool", "getdisplaygeometry"]),
        { timeoutMs: 15_000, maxOutput: 4096 },
      );
      if (probe.exitCode === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `The machine started but its screen did not come up: ${firstLine(
            probe.stderr,
          )}`,
        );
      }
      await sleep(300);
    }
  }

  /** Whether an existing container mounts the home volume. A container
   * created before the volume existed keeps its home in its own writable
   * layer; retiring it without carrying the files out would lose everything
   * the agent wrote. */
  async function mountsHomeVolume(name: string): Promise<boolean> {
    const result = await run(
      podman([
        "container",
        "inspect",
        "--format",
        "{{range .Mounts}}{{.Destination}}={{.Type}} {{end}}",
        name,
      ]),
      { timeoutMs: 30_000, maxOutput: 8192 },
    );
    if (result.exitCode !== 0) return true;
    return result.stdout.includes(`${VM_WORKDIR}=volume`);
  }

  /** Carry the home out of the legacy container and into the shared volume.
   *
   * Only an installation older than the volume needs this. The old container
   * is stopped, its home is read out, and a throw-away container mounts both
   * the volume and the saved copy to move the files across. A failure keeps
   * the saved copy and names its path: replacing the container would throw
   * the agent's work away, and a machine that starts empty after an update is
   * the failure this exists to prevent. */
  async function copyLegacyHomeToVolume(): Promise<void> {
    await ensureImage();
    const saved = await fsp.mkdtemp(join(osTmpdir(), "lumisca-stella-legacy-"));
    let moved = false;
    try {
      await stopContainer(VM_LEGACY_CONTAINER_NAME);
      const copyOut = await run(
        podman(["cp", `${VM_LEGACY_CONTAINER_NAME}:${VM_WORKDIR}`, saved]),
        { timeoutMs: VM_COPY_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
      );
      if (copyOut.exitCode !== 0) {
        throw new Error(
          `Could not read the old machine's files to move them onto its new ` +
            `home: ${detail(copyOut)}`,
        );
      }
      const moved_in = await run(
        podman([
          "run",
          "--rm",
          "--userns",
          `keep-id:uid=${VM_UID},gid=${VM_GID}`,
          "--volume",
          `${VM_HOME_VOLUME}:${VM_WORKDIR}`,
          "--volume",
          `${saved}:/lumisca-legacy:ro`,
          VM_IMAGE_NAME,
          "sh",
          "-c",
          `cp -a /lumisca-legacy/${basename(VM_WORKDIR)}/. ${VM_WORKDIR}/`,
        ]),
        { timeoutMs: VM_COPY_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
      );
      if (moved_in.exitCode !== 0) {
        throw new Error(
          `The old machine's files were read but could not be put back ` +
            `(they are kept in ${saved}): ${detail(moved_in)}`,
        );
      }
      moved = true;
    } finally {
      if (moved) await fsp.rm(saved, { recursive: true }).catch(() => {});
    }
  }

  /** The retirement in flight (or finished). */
  let retiring: Promise<void> | undefined;

  /**
   * Remove the single container the per-agent machines replaced.
   *
   * Done at the FIRST machine start, not when the host is attached: an app
   * that only reads a status, a packaged smoke test or a script has no
   * business stopping the machine a running installation is using. A failure
   * is not memoized — the files may still be on the old container, so the
   * next start tries again — and it does not stop the new machine from
   * starting: the home is on the shared volume either way.
   */
  function retireLegacy(): Promise<void> {
    retiring ??= (async () => {
      if (!(await containerExists(VM_LEGACY_CONTAINER_NAME))) return;
      if (!(await mountsHomeVolume(VM_LEGACY_CONTAINER_NAME))) {
        await copyLegacyHomeToVolume();
      } else {
        await stopContainer(VM_LEGACY_CONTAINER_NAME);
      }
      await removeContainer(VM_LEGACY_CONTAINER_NAME);
    })().catch((error) => {
      retiring = undefined;
      throw error;
    });
    return retiring;
  }

  const host: VmHost = {
    status: (statusOptions) => hostStatus(statusOptions?.fresh === true),
    ensureImage,
    get building() {
      return buildInFlight !== undefined;
    },
    machine: (agentId) => {
      const known = machines.get(agentId);
      if (known !== undefined) return known;
      const machine = createMachine(agentId);
      machines.set(agentId, machine);
      return machine;
    },
    async stopAll() {
      // The machines this process knows about: the ones it started, or the
      // ones it found running when a conversation asked. A machine nobody
      // touched here is left alone — another installation on the same podman
      // may be using it — and a machine a crashed server left keeps running
      // until its agent is used again, when this process adopts it (the
      // container name is the agent's, so there is nothing to tell them
      // apart).
      let failure: Error | undefined;
      for (const [agentId, manager] of [...machines]) {
        try {
          await manager.stop();
          machines.delete(agentId);
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      cached = null;
      verifiedOf.clear();
      if (failure !== undefined) throw failure;
    },
    retireLegacy,
  };

  function createMachine(agentId: string): VmManager {
    const name = vmContainerName(agentId);
    let machineCached: { at: number; status: VmStatus } | null = null;
    let machineInFlight: Promise<VmStatus> | undefined;

    async function status(readFresh = false): Promise<VmStatus> {
      const now = Date.now();
      if (
        !readFresh &&
        machineCached !== null &&
        now - machineCached.at < VM_STATUS_CACHE_MS
      ) {
        return machineCached.status;
      }
      if (machineInFlight !== undefined) return await machineInFlight;
      const read = (async () => {
        try {
          const result = await readStatus();
          machineCached = { at: Date.now(), status: result };
          return result;
        } finally {
          machineInFlight = undefined;
        }
      })();
      machineInFlight = read;
      return await read;
    }

    async function readStatus(): Promise<VmStatus> {
      const shared = await hostStatus();
      if (shared.state !== "ready") {
        return {
          state: shared.state,
          vncPort: null,
          reason: shared.reason,
        };
      }
      const facts = await readContainerFacts(name);
      if (facts === undefined) {
        return { state: "container_missing", vncPort: null, reason: "" };
      }
      if (facts.agent !== agentId) {
        return {
          state: "stopped",
          vncPort: facts.vncPort,
          reason:
            facts.agent === ""
              ? "the machine has no agent label (it was not created by this " +
                "application)"
              : `the machine belongs to another agent (${facts.agent})`,
        };
      }
      if (facts.status !== "running") {
        return { state: "stopped", vncPort: null, reason: "" };
      }
      // Judged before the contract check, which costs a `podman exec`: this
      // answer came with the inspect above, and a machine without its ceilings
      // is replaced rather than asked to prove anything about itself.
      const limits = limitsMismatch(facts);
      if (limits !== null) {
        return { state: "stopped", vncPort: facts.vncPort, reason: limits };
      }
      // Running is not enough: the machine is usable when its own values match
      // the contract (see contractOf — verified once per instance).
      const contract = await contractOf(facts, agentId);
      if (contract !== null) {
        return { state: "stopped", vncPort: facts.vncPort, reason: contract };
      }
      return { state: "running", vncPort: facts.vncPort, reason: "" };
    }

    return {
      status: (statusOptions) => status(statusOptions?.fresh === true),

      async start() {
        // The first machine of this installation takes the old single
        // container out of the way (its home is on the volume the new ones
        // mount). Done here rather than at attach: reading a status, running
        // a packaged smoke test or opening the settings must not stop the
        // machine a running installation is using. A failure is reported but
        // does not block the start — the new machine has its own home.
        try {
          await retireLegacy();
        } catch (error) {
          log.warn(
            `could not retire the old single machine: ${errorMessage(error)}`,
          );
        }
        const before = await status(true);
        switch (before.state) {
          case "podman_missing":
          case "podman_unusable":
            throw new Error(before.reason);
          case "running":
            return before;
          case "image_missing":
          case "image_stale":
            // The image is the host's: one build serves every machine. The
            // container this agent had was created from the old definition,
            // so it is replaced (a missing one is simply created).
            await ensureImage();
            await recreateContainer(agentId);
            break;
          case "container_missing":
            await createContainer(agentId);
            await startContainer(name);
            break;
          case "stopped":
            if (before.reason !== "") {
              // The container exists but is broken (a drifted image, a dead
              // entry point, another agent's label). Recreating it is the only
              // way forward. The home is on the shared volume, so nothing the
              // agent wrote is lost by that.
              await recreateContainer(agentId);
            } else {
              await startContainer(name);
            }
            break;
        }
        report({ phase: "verifying" });
        await waitForScreen(name);
        machineCached = null;
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
        // Stopping is idempotent: a machine that is already down (a second
        // sleep, a stop after a crash) is not an error, and `podman stop`
        // answers one in a single call without an existence check first.
        await stopContainer(name);
        machineCached = null;
        verifiedOf.delete(agentId);
      },

      async remove() {
        if (await containerExists(name)) {
          await stopContainer(name);
          await removeContainer(name);
        }
        machineCached = null;
        verifiedOf.delete(agentId);
        machines.delete(agentId);
      },

      async vncPort() {
        const current = await status(true);
        if (current.state !== "running") return null;
        return current.vncPort;
      },

      async startDesktop() {
        const result = await run(
          podmanExec(name, [VM_DESKTOP_SCRIPT, "start", agentId], {
            workdir: VM_WORKDIR,
          }),
          { timeoutMs: VM_DESKTOP_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `Could not start the agent's desktop: ${detail(result)}`,
          );
        }
      },

      async stopDesktop() {
        // A desktop that is already down is not an error: stopping is
        // idempotent, and the caller stops what it may no longer remember.
        await run(
          podmanExec(name, [VM_DESKTOP_SCRIPT, "stop"], {
            workdir: VM_WORKDIR,
          }),
          { timeoutMs: VM_STOP_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
        );
      },
    };
  }

  return host;
}

/** Run a command inside the machine (the entry point every backend uses). */
export type VmExec = (
  command: readonly string[],
  options: VmExecOptions,
) => Promise<VmExecResult>;

/** The same seam for a command whose output is binary (a screen capture). */
export type VmExecBytes = (
  command: readonly string[],
  options: VmExecOptions,
) => Promise<VmExecBytesResult>;

export type VmExecBytesResult = VmCommandBytesResult;

export interface VmExecOptions {
  workdir?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: Uint8Array | AsyncIterable<Uint8Array>;
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
    ...Object.entries(exec.env ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
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

/** Run a command inside one machine, with the container's name and workdir
 * already applied. This is the seam the file/shell/screen backends use; it
 * exists so none of them has to know podman's argument shape. */
export function createVmExec(options: {
  run: VmCommandRunner;
  containerName: string;
}): VmExec {
  return (command, exec) =>
    options.run(
      execArgv(options.containerName, command, exec),
      execOptions(exec),
    );
}

/** The byte variant of {@link createVmExec}: the same argument shape, with
 * the output kept as raw bytes (a PNG must not be decoded as text). */
export function createVmExecBytes(options: {
  runBytes: VmCommandBytesRunner;
  containerName: string;
}): VmExecBytes {
  return (command, exec) =>
    options.runBytes(
      execArgv(options.containerName, command, exec),
      execOptions(exec),
    );
}

/** Options of one interactive exec: a channel to a program inside the
 * machine, with the container's name and workdir already applied. */
export interface VmChannelExecOptions extends VmChannelOptions {
  workdir?: string;
  env?: Record<string, string>;
}

/** Opens an interactive exec in the machine (see vm/channel.ts). */
export type VmChannelOpener = (
  command: readonly string[],
  options: VmChannelExecOptions,
) => Promise<VmChannel>;

/** The argv of one interactive exec: always `--interactive`, because the
 * channel writes to the program's stdin. */
function channelArgv(
  container: string,
  command: readonly string[],
  options: VmChannelExecOptions,
): string[] {
  return podman([
    "exec",
    "--interactive",
    ...Object.entries(options.env ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--workdir",
    options.workdir ?? VM_WORKDIR,
    container,
    ...command,
  ]);
}

/** Open an interactive exec, with the container's name and workdir already
 * applied. The scripting tool call's seam: the only caller that needs the
 * exchange to stay live (see vm/channel.ts). */
export function createVmChannel(options: {
  open: VmChannelRunner;
  containerName: string;
}): VmChannelOpener {
  return (command, exec) =>
    options.open(channelArgv(options.containerName, command, exec), {
      timeoutMs: exec.timeoutMs,
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      ...(exec.maxStderrChars !== undefined
        ? { maxStderrChars: exec.maxStderrChars }
        : {}),
    });
}
