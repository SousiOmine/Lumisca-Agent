/**
 * The container side of stella mode, as the rest of the application sees it.
 *
 * These are the states and the two interfaces (`VmHost` — what every machine
 * shares — and `VmManager` — one agent's machine) the server, the machine
 * service and the tests are written against. They live here, apart from the
 * code that decides them, so the modules that produce them (host status,
 * image, lifecycle, contract) depend on the shape rather than on each other.
 */

import type { VmCommandRunner } from "./command.ts";

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
