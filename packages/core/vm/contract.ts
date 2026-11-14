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

/** Where the environment variables the user entered through `vm_env` live.
 *
 * Two files, both 0600 and both machine-wide (the machine is one machine: an
 * agent's key is the same key in another agent's shell). `env.json` is the
 * truth — one object, rewritten a key at a time — and `env.sh` is what a
 * command sources, generated from it. Keeping the pair is what makes an
 * overwrite possible without touching the other entries: a shell file alone
 * cannot be merged safely, because a value may contain anything.
 *
 * They sit under the agent's home, which is a volume (VM_HOME_VOLUME), so a
 * rebuilt machine keeps them. */
export const VM_ENV_DIR = `${VM_WORKDIR}/.lumisca-env`;
export const VM_ENV_JSON = `${VM_ENV_DIR}/env.json`;
export const VM_ENV_SH = `${VM_ENV_DIR}/env.sh`;

/** The virtual X display the container boots on its own (`entry.sh`).
 *
 * No agent works here: the desktops are `vmDisplayOf(slot)`, one display
 * above. This one is the machine's screen — the contract proves it is up and
 * sized as expected — and it is what `DISPLAY` names for a process that is
 * not on a desktop, such as a command the agent runs through `bash`. A
 * program started there by hand is on no conversation's screen rather than on
 * somebody else's. */
export const VM_DISPLAY = ":99";

/** The screen size Xvfb is created with. Fixed, because the agent reads
 * coordinates off a screenshot and types them back: a resized screen would
 * silently invalidate every coordinate it had already read. */
export const VM_SCREEN_WIDTH = 1280;
export const VM_SCREEN_HEIGHT = 800;

/** Where noVNC's websockify listens inside the container, for the first
 * desktop; the others follow it (see `vmWebsockifyPortOf`). */
export const VM_VNC_PORT = 6080;

/** Where x11vnc listens inside the container, for the first desktop; the
 * others follow it. The host reaches it only through websockify. */
export const VM_VNC_RFB_PORT = 5900;

/** How many desktops one machine runs at once.
 *
 * Each is a separate X server, window manager, session bus, browser and
 * profile, so an agent's windows, pointer, logins and accessibility tree are
 * its own. Everything the machine offers — the screen tools, the semantic
 * tools, `vm_launch`, the clipboard — follows the conversation's `DISPLAY`
 * and bus (see container/desktop.sh and vm/machine.ts). The shell is not
 * desktop work and keeps the machine's own display (see VM_DISPLAY).
 *
 * Four is a chat's worth of agents without paying for more browsers than a
 * person would open. A fifth conversation takes the slot used least recently;
 * that desktop is stopped first, and started again when its agent next uses
 * its screen (the profile keeps the logins). */
export const VM_DESKTOP_SLOTS = 4;

/** The X display of one desktop slot: `:100` for the first, then `:101`,
 * `:102`, `:103`. One above the machine's own display, so nothing that starts
 * on `DISPLAY` without naming a desktop lands on an agent's screen. */
export function vmDisplayOf(slot: number): string {
  return `:${100 + slot}`;
}

/** The websockify port a slot's desktop listens on inside the container. */
export function vmWebsockifyPortOf(slot: number): number {
  return VM_VNC_PORT + slot;
}

/** The container ports the machine publishes for its desktops, as one podman
 * `--publish` range (the host port of each is assigned at creation). */
export const VM_VNC_PORT_RANGE = `${VM_VNC_PORT}-${
  VM_VNC_PORT + VM_DESKTOP_SLOTS - 1
}`;

/** The program that starts and stops one desktop inside the machine
 * (container/desktop.sh). */
export const VM_DESKTOP_SCRIPT = "/usr/local/lib/lumisca/desktop.sh";

/** Where the per-agent browser profiles live inside the machine, one
 * directory per agent (`<this>/<agent id>`). The directory is the agent's
 * identity: a conversation reopened later has the logins it left, and two
 * agents never share one. Under the home, which is a volume, so a rebuilt
 * machine keeps them. */
export const VM_PROFILE_ROOT = `${VM_WORKDIR}/.config/chromium`;

/** The account the container's processes run as (the Containerfile creates
 * it; `--userns keep-id` maps it onto the host user so mounted-write cases
 * stay impossible to get wrong). */
export const VM_UID = 1000;
export const VM_GID = 1000;

/** The account's name inside the machine. The Containerfile creates it, and
 * the passwordless `sudo` rule is written against this name rather than a
 * uid (see `verifyImageContract`, which proves the rule works). */
export const VM_USER = "agent";

/** Container and image names. Distinct from any name the user's other
 * containers use, and stable so a restart reuses the same machine. */
export const VM_CONTAINER_NAME = "lumisca-stella";
export const VM_IMAGE_NAME = "lumisca-stella";

/** The image the run probe starts.
 *
 * Not the machine's own image: the probe answers "can this host run a
 * container at all", and asking it with a definition that is not built yet
 * would make a first run look like a broken host. The bare Debian base comes
 * down in seconds and runs nothing — the container only has to exist for the
 * runtime's answer to be readable. */
export const VM_PROBE_IMAGE = "docker.io/library/debian:bookworm-slim";

/** The volume the agent's home lives on.
 *
 * The home — the files the agent wrote, the folders its conversations work
 * in — must outlive the container, because the container does not: a release
 * rebuilds it, and a `podman rm` or a reset storage takes it away entirely.
 * Kept inside the container, the home was lost with it, and the two paths
 * that recreate the container disagreed about that (an image rebuild carried
 * it across with `podman cp`, a missing container did not).
 *
 * A named volume is the smallest thing that survives all of that and still
 * keeps the machine isolated: it is podman's own storage, not a host
 * directory, so nothing of the host becomes reachable from inside. The
 * container's uid 1000 owns what it writes there, because the volume is
 * created with the same userns mapping the container runs with.
 *
 * No setting for the name, for the same reason as every other value here. */
export const VM_HOME_VOLUME = "lumisca-stella-home";

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

/** The machine-wide skills folder inside the VM: every stella agent reads
 * it, so a skill several agents need lives here. The user's own skill files
 * are not here (the host is not mounted), which keeps the folder safe to
 * edit from inside the machine. */
export const VM_SKILLS_DIR = `${VM_WORKDIR}/.agents/skills`;

/** The skills folder of one stella agent: the Agent Skills convention
 * (`.agents/skills`) inside its working folder, so its skills are files in
 * the place its shell already works and no two agents share a catalog by
 * accident. */
export function vmAgentSkillsDir(agentId: string): string {
  return `${vmAgentDir(agentId)}/.agents/skills`;
}

/** The session bus `entry.sh` starts, at a fixed path: the machine's own bus,
 * the one the image's `DBUS_SESSION_BUS_ADDRESS` names and a command run
 * without a desktop reaches. The desktops have one each (see
 * `vmBusSocketOf`).
 *
 * Fixed because the server enters the machine with `podman exec`, which
 * inherits nothing from the container's first process: an autolaunched bus
 * (`dbus-launch`) has a different address on every start and could never be
 * found. The Containerfile exports the same address so a shell the agent runs
 * by hand reaches the same bus; the contract check proves it against the
 * running container. */
export const VM_DBUS_DIR = "/tmp/lumisca-dbus";
export const VM_DBUS_SOCKET = `${VM_DBUS_DIR}/session.sock`;
export const VM_DBUS_ADDRESS = `unix:path=${VM_DBUS_SOCKET}`;

/** The socket of one desktop's session bus.
 *
 * Every desktop starts its own. An AT-SPI registry lives on the session bus,
 * so a shared one would let one agent's semantic tools (`vm_find` and the
 * rest) read and press another agent's windows — the failure the separate
 * displays exist to prevent. */
export function vmBusSocketOf(slot: number): string {
  return `${VM_DBUS_DIR}/session-${slot}.sock`;
}

/** That bus's address, in the form an environment variable carries it. */
export function vmBusAddressOf(slot: number): string {
  return `unix:path=${vmBusSocketOf(slot)}`;
}

/** The gsettings key that makes a GTK application load its ATK bridge. *
 * `entry.sh` sets it before anything else starts, because an app reads it once
 * at start-up: a process that began while it was false never appears on the
 * accessibility bus, whatever is set later. This is the single switch the
 * machine's semantic tools depend on. */
export const VM_A11Y_GSETTINGS_KEY =
  "org.gnome.desktop.interface toolkit-accessibility";

/** How many wheel notches one scroll amount means.
 *
 * The tool says "positive scrolls down"; this is the unit that sentence
 * counts in. It lives here because three places describe the same rule: the
 * tool's schema, the tool's result text, and the screen mapper that turns the
 * amount into wheel clicks. */
export const VM_SCROLL_NOTCH = 100;
/** Most notches one call may send (a stray large amount must not spin a list
 * for minutes). */
export const VM_SCROLL_MAX_NOTCHES = 20;

/** The helper the semantic tools run inside the machine (`vm_find` / `vm_do`
 * / `vm_wait`): a Python program over `python3-pyatspi`. Written into the
 * image by the Containerfile from the file beside it, so the copy on disk and
 * the copy that runs are the same file (see the digest label). */
export const VM_A11Y_HELPER = "/usr/local/lib/lumisca/a11y.py";

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

/** How long a PASSED contract check is reused for one container instance.
 *
 * The check crosses into the machine (`podman exec`), so asking it on every
 * status read made each poll of the watching client cost a process spawn —
 * selecting an agent in stella mode spent about 400 ms on it alone. The
 * values it proves are set once at start-up and cannot change while the same
 * instance runs, so the answer is kept — but not forever: the screen can die
 * inside a running container (Xvfb or Chromium crashing), and a machine
 * reported as working while its screen is gone fails deep inside a tool. A
 * bounded window notices that within half a minute. */
export const VM_CONTRACT_CACHE_MS = 30_000;
