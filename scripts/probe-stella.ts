/**
 * Manual probe: is stella mode usable on this machine, and does it behave the
 * way the UI assumes?
 *
 * stella mode needs podman and a container image that takes minutes to build
 * the first time, so this is not part of the automated suite. It answers, in
 * order:
 *
 *   1. what the server reports (`GET /api/stella/status`) before anything is
 *      started — the mode must be offered or refused, with a reason;
 *   2. whether the mode can be stored (`PUT /api/stella/mode`);
 *   3. whether the machine starts (image build included), and what its screen
 *      reports (`podman exec … xdotool getdisplaygeometry`);
 *   4. whether the machine stops again.
 *
 * Run from the repository root:
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
 *     --allow-sys --allow-ffi scripts/probe-stella.ts [--start] [--no-stop]
 *
 * Without `--start` nothing is built or started: only the read-only questions
 * (1) are asked, which is what a normal `deno task dev` user wants.
 */
import { LumiscaCore } from "../packages/core/mod.ts";
import { createVmManager } from "../packages/core/vm/container.ts";
import { createVmExec } from "../packages/core/vm/container.ts";
import { runVmCommand } from "../packages/core/vm/command.ts";
import { VM_CONTAINER_NAME, VM_DISPLAY } from "../packages/core/vm/contract.ts";
import { stellaContainerDir } from "../packages/server/paths.ts";
import { repoRoot } from "./lib.ts";

const start = Deno.args.includes("--start");
const noStop = Deno.args.includes("--no-stop");

function log(message: string): void {
  console.log(message);
}

const containerDir = stellaContainerDir(
  repoRoot,
  Deno.execPath(),
  (path) => {
    try {
      return Deno.statSync(path).isDirectory;
    } catch {
      return false;
    }
  },
);
log(`container files: ${containerDir}`);

const vm = createVmManager({ containerDir });

// 1. What does the machine say about itself?
const status = await vm.status({ fresh: true });
log(`state: ${status.state}`);
if (status.reason !== "") log(`reason: ${status.reason}`);
if (status.vncPort !== null) log(`VNC port: ${status.vncPort}`);

if (status.state === "podman_missing") {
  log("\nstella mode is NOT available on this machine (see the reason).");
  Deno.exit(1);
}
log("\nstella mode is available on this machine.");

// 2. The core-level mode switch, with the verdict a real client reads first.
const core = LumiscaCore.forTesting();
try {
  core.setStellaVm(vm);
  const availability = await core.getStellaAvailability();
  log(`availability: ${JSON.stringify(availability)}`);
  core.setAppMode("stella");
  log(`stored mode: ${core.getAppMode()}`);
} finally {
  void core.close();
}

if (!start) {
  log("\n(--start not given: nothing was built or started)");
  Deno.exit(0);
}

// 3. Start the machine (a first run builds the image: minutes).
log("\nstarting the machine…");
const started = await vm.start();
log(`started: ${started.state} (VNC port ${started.vncPort})`);

const exec = createVmExec({ run: runVmCommand });
const probe = await exec([
  "sh",
  "-c",
  'printf "%s|%s|%s" "$DISPLAY" "$(id -u)" "$(pwd)"',
], {
  timeoutMs: 30_000,
});
log(
  `inside the machine: ${probe.stdout} (expected ${VM_DISPLAY}|1000|/home/agent)`,
);

const geometry = await exec(["xdotool", "getdisplaygeometry"], {
  timeoutMs: 30_000,
});
log(`screen: ${geometry.stdout.trim()} (expected 1280 800)`);

const listing = await exec(["sh", "-c", "ls -a /home/agent | head -5"], {
  timeoutMs: 30_000,
});
log(`home: ${listing.stdout.trim().replaceAll("\n", " ")}`);

// The screen capture the agent's vm_screenshot tool takes.
const shot = await new Deno.Command("podman", {
  args: [
    "exec",
    "--workdir",
    "/home/agent",
    VM_CONTAINER_NAME,
    "scrot",
    "--pointer",
    "--overwrite",
    "--silent",
    "/dev/stdout",
  ],
  stdout: "piped",
  stderr: "piped",
}).output();
log(
  shot.success
    ? `screenshot: ${shot.stdout.byteLength} bytes (PNG signature ${
      new Uint8Array(shot.stdout.slice(0, 4)).join(",")
    })`
    : `screenshot FAILED: ${new TextDecoder().decode(shot.stderr)}`,
);

// 4. Stop it (unless asked to keep it for manual poking).
if (!noStop) {
  await vm.stop();
  log("\nmachine stopped.");
} else {
  log("\n(--no-stop: the machine is left running)");
  log(`  screen: podman port ${VM_CONTAINER_NAME} 6080`);
}
