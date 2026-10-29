/**
 * Fixed values of the stella virtual machine.
 *
 * These are written twice by necessity: here (the server runs `podman exec`
 * with them) and in the container image's own files (`container/entry.sh`
 * exports DISPLAY; the Containerfile creates the user with this uid/gid and
 * sets the workdir). The values are checked against the running container at
 * start-up — `verifyImageContract` runs the same probes the image answers —
 * so a drifted pair fails loudly instead of quietly breaking screenshots or
 * permissions.
 *
 * There is deliberately no setting for any of them: a knob nobody can use
 * correctly is worse than a constant.
 */

/** The agent's home and working directory inside the VM. The stella file
 * backend's single root is this directory. */
export const VM_WORKDIR = "/home/agent";

/** The virtual X display the container runs Xvfb on. */
export const VM_DISPLAY = ":99";

/** The screen size Xvfb is created with. Fixed, because the agent reads
 * coordinates off a screenshot and types them back: a resized screen would
 * silently invalidate every coordinate it had already read. */
export const VM_SCREEN_WIDTH = 1280;
export const VM_SCREEN_HEIGHT = 800;

/** Where noVNC's websockify listens inside the container. */
export const VM_VNC_PORT = 6080;

/** The account the container's processes run as (the Containerfile creates
 * it; `--userns keep-id` maps it onto the host user so mounted-write cases
 * stay impossible to get wrong). */
export const VM_UID = 1000;
export const VM_GID = 1000;

/** Container and image names. Distinct from any name the user's other
 * containers use, and stable so a restart reuses the same machine. */
export const VM_CONTAINER_NAME = "lumisca-stella";
export const VM_IMAGE_NAME = "lumisca-stella";

/** Label marking containers this application created, so it can tell its own
 * machine from a same-named one a user made by hand. */
export const VM_MANAGED_LABEL = "lumisca.stella=1";

/** Name of the directory the Containerfile and entry.sh are staged into
 * beside a packaged binary (see packages/server/paths.ts and
 * scripts/build-server.ts). In a repository checkout they live in this
 * directory instead, so the server resolves the location rather than
 * assuming one. */
export const VM_CONTAINER_DIR_NAME = "stella-container";

/** The Containerfile's file name inside that directory. */
export const VM_CONTAINERFILE_NAME = "Containerfile";

/** Where stella's published skills live inside the VM (the Agent Skills
 * convention, so a skill the agent writes is one it can also read). */
export const VM_SKILLS_DIR = `${VM_WORKDIR}/.agents/skills`;

/** Timeouts for the container operations. Building takes minutes on a first
 * run (a Debian base plus Chromium); everything else is a local call. */
export const VM_BUILD_TIMEOUT_MS = 15 * 60_000;
export const VM_RUN_TIMEOUT_MS = 60_000;
export const VM_REMOVE_TIMEOUT_MS = 60_000;
export const VM_STOP_TIMEOUT_MS = 60_000;

/** How long a status query is reused. The screen pane and the status
 * endpoint ask repeatedly while a client watches, and every answer is a
 * `podman` process; callers that just changed the state bypass the cache. */
export const VM_STATUS_CACHE_MS = 1_000;
