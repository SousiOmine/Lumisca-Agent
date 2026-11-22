/**
 * The contract check: the values this application writes down (display, uid,
 * workdir, screen size, passwordless sudo, the session bus, the
 * accessibility switch, the helper and the desktop helper's numbering) proven
 * against the RUNNING container, and the pass remembered for the instance it
 * was made about.
 *
 * A drifted image breaks screenshots, file ownership or the semantic tools
 * silently, so the machine is refused rather than started into that state. The
 * values are read by ONE `podman exec` that prints `name=value` lines, and a
 * pass is kept for `<container id>/<started at>`: a stop/start or a recreation
 * changes that key, and the client polls this while it watches stella mode.
 */

import { firstLine } from "../lines.ts";
import type { VmCommandRunner } from "./command.ts";
import type { ContainerFacts } from "./container-facts.ts";
import {
  VM_A11Y_GSETTINGS_KEY,
  VM_A11Y_HELPER,
  VM_CONTRACT_CACHE_MS,
  VM_DBUS_ADDRESS,
  VM_DBUS_SOCKET,
  VM_DESKTOP_SCRIPT,
  VM_DISPLAY,
  VM_PROFILE_ROOT,
  VM_SCREEN_HEIGHT,
  VM_SCREEN_WIDTH,
  VM_UID,
  VM_USER,
  VM_VNC_PORT,
  VM_VNC_RFB_PORT,
  VM_WORKDIR,
  vmCacheHomeOf,
  vmContainerName,
} from "./contract.ts";
import { podmanExec } from "./podman.ts";

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

export interface ContractChecker {
  /** The mismatch as a sentence, or null when this instance matches. */
  check(facts: ContainerFacts, agentId: string): Promise<string | null>;
  /** Forget an agent's pass after its container was stopped or removed. */
  forget(agentId: string): void;
  /** Forget every pass (app shutdown). */
  clear(): void;
}

export function createContractChecker(options: {
  run: VmCommandRunner;
}): ContractChecker {
  const run = options.run;
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
   * match contract.ts. Each of those used to be its own spawn. */
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

  return {
    check: contractOf,
    forget: (agentId) => {
      verifiedOf.delete(agentId);
    },
    clear: () => verifiedOf.clear(),
  };
}
