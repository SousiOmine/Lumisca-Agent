/**
 * Fixed values of the stella virtual machine.
 *
 * These are written twice by necessity: here (the server runs `podman exec`
 * with them) and in the container image's own files (`container/entry.sh`
 * exports DISPLAY; the Containerfile creates the user with this uid/gid, its
 * passwordless sudo rule and the workdir). The values are checked against the
 * running container at start-up — `verifyImageContract` runs the same probes
 * the image answers — so a drifted pair fails loudly instead of quietly
 * breaking screenshots, permissions or sudo.
 *
 * There is deliberately no setting for any of them: a knob nobody can use
 * correctly is worse than a constant.
 */

/** The agent's home and working directory inside the VM (also the path
 * file tools resolve relative paths from, and where bash starts). */
export const VM_WORKDIR = "/home/agent";

/** The directory the per-agent working folders are listed under. Each
 * stella agent gets one (`<this>/<agent id>`), the way Terasuma gives each
 * Tera one: the folder is the agent's default home for relative paths, not
 * a boundary — the file tools reach anywhere inside the machine. */
export const VM_AGENTS_DIR = `${VM_WORKDIR}/agents`;

/** The working folder of one stella agent (absolute, inside the machine). */
export function vmAgentDir(agentId: string): string {
  return `${VM_AGENTS_DIR}/${agentId}`;
}

/** Where background command logs and pid files live (outside any agent's
 * working folder, so they are not part of the agent's own files). */
export const VM_BG_DIR = `${VM_WORKDIR}/.lumisca-bg`;

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

/** The account's name inside the machine. The Containerfile creates it, and
 * the passwordless `sudo` rule is written against this name rather than a
 * uid (see `verifyImageContract`, which proves the rule works). */
export const VM_USER = "agent";

/** The command that proves the agent's sudo is passwordless. Run as the
 * machine's own account (`podman exec` without `--user`), `sudo -n` fails
 * instead of prompting, so a missing rule is a false answer and not a hang.
 * A machine that fails this is refused at start-up: the password prompt would
 * block a shell the agent started, with nothing on the screen to answer it. */
export const VM_SUDO_PROBE = ["sudo", "-n", "true"] as const;

/** Container and image names. Distinct from any name the user's other
 * containers use, and stable so a restart reuses the same machine. */
export const VM_CONTAINER_NAME = "lumisca-stella";
export const VM_IMAGE_NAME = "lumisca-stella";

/** Label marking containers this application created, so it can tell its own
 * machine from a same-named one a user made by hand. */
export const VM_MANAGED_LABEL = "lumisca.stella=1";

/** Label the built image carries, recording which version of the container
 * files (the Containerfile and the files it copies from the same directory)
 * produced it. The manager compares it with the files on disk, so editing the
 * Containerfile — or installing a release that did — rebuilds the image
 * instead of silently running the old one. Without it an image is built once
 * and keeps that definition for the rest of the installation's life, which
 * is how a machine ends up lacking something its own definition grants (the
 * agent's passwordless sudo). */
export const VM_IMAGE_DIGEST_LABEL = "lumisca.container-digest";

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
 * run (a Debian base plus Chromium); everything else is a local call.
 * `podman cp` moves the agent's home when the machine is replaced, so it gets
 * a generous bound of its own: a home with a checkout in it is not small. */
export const VM_BUILD_TIMEOUT_MS = 15 * 60_000;
export const VM_RUN_TIMEOUT_MS = 60_000;
export const VM_COPY_TIMEOUT_MS = 5 * 60_000;
export const VM_REMOVE_TIMEOUT_MS = 60_000;
export const VM_STOP_TIMEOUT_MS = 60_000;

/** How long a status query is reused. The screen pane and the status
 * endpoint ask repeatedly while a client watches, and every answer is a
 * `podman` process; callers that just changed the state bypass the cache. */
export const VM_STATUS_CACHE_MS = 1_000;
