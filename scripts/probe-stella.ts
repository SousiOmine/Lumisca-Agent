import { forTestingCore } from "@lumisca/core";
/**
 * Manual probe: is stella mode usable on this machine, and does one agent's
 * machine behave the way the UI assumes?
 *
 * stella mode needs podman and a container image that takes minutes to build
 * the first time, so this is not part of the automated suite. It answers, in
 * order:
 *
 *   1. what the server reports (`GET /api/stella/status`) before anything is
 *      started — the mode must be offered or refused, with a reason;
 *   2. whether one agent's machine starts (image build included), what its
 *      screen reports (`podman exec … xdotool getdisplaygeometry`) and
 *      whether the desktop answers;
 *   3. whether the machine stops again.
 *
 * Run from the repository root:
 *   bun run scripts/probe-stella.ts [--start --agent <id>] [--no-stop]
 *
 * Without `--start` nothing is built or started: only the read-only questions
 * (1) are asked, which is what a normal `bun run dev` user wants. `--start`
 * names the agent whose machine is poked, because the machines are one per
 * agent and the script must not pick one on its own.
 */

import * as fsSync from "node:fs";
import { LumiscaCore } from "../packages/core/mod.ts";
import { exit, runProcess } from "../packages/core/process.ts";
import { runVmCommand } from "../packages/core/vm/command.ts";
import { createVmExec, createVmHost } from "../packages/core/vm/container.ts";
import { VM_DISPLAY, vmContainerName } from "../packages/core/vm/contract.ts";
import { createVmSemanticTools } from "../packages/core/vm/semantic.ts";
import { stellaContainerDir } from "../packages/server/paths.ts";
import { repoRoot } from "./lib.ts";

const args = process.argv.slice(2);
const start = args.includes("--start");
const noStop = args.includes("--no-stop");
const agentAt = args.indexOf("--agent");
const agentId = agentAt === -1 ? undefined : args[agentAt + 1];

function log(message: string): void {
  console.log(message);
}

const containerDir = stellaContainerDir(repoRoot, process.execPath, (path) => {
  try {
    return fsSync.statSync(path).isDirectory();
  } catch {
    return false;
  }
});
log(`container files: ${containerDir}`);

const host = createVmHost({ containerDir });

// 1. What do the installation's prerequisites say?
const status = await host.status({ fresh: true });
log(`state: ${status.state}`);
if (status.reason !== "") log(`reason: ${status.reason}`);

if (status.state === "podman_missing" || status.state === "podman_unusable") {
  log("\nstella mode is NOT available on this machine (see the reason).");
  exit(1);
}
log("\nstella mode is available on this machine.");

// 2. The verdict a real client reads before it offers the mode.
const core = forTestingCore();
try {
  core.services.stellaMachines.setStellaVm(host);
  const availability =
    await core.services.stellaMachines.getStellaAvailability();
  log(`availability: ${JSON.stringify(availability)}`);
} finally {
  // Detached first: `close()` stops the machines it holds, and this script
  // shares the application's containers. Stopping is the explicit step at the
  // end (`--start` without `--no-stop`), never a side effect of asking a
  // question about availability.
  core.services.stellaMachines.setStellaVm(undefined);
  void core.close();
}

if (!start) {
  log("\n(--start not given: nothing was built or started)");
  exit(0);
}
if (agentId === undefined) {
  log(
    "\n(--start needs --agent <id>: the machines are one per agent, and this " +
      "script does not pick one)",
  );
  exit(1);
}

const name = vmContainerName(agentId);
const vm = host.machine(agentId);

// 3. Start the machine (a first run builds the image: minutes).
log(`\nstarting ${name}…`);
const started = await vm.start();
log(`started: ${started.state} (VNC port ${started.vncPort})`);

// The desktop is what a conversation's screen tools reach: the browser must
// exist before the semantic probe asks for its window.
await vm.startDesktop();

const exec = createVmExec({ run: runVmCommand, containerName: name });
const probe = await exec(
  ["sh", "-c", 'printf "%s|%s|%s" "$DISPLAY" "$(id -u)" "$(pwd)"'],
  {
    timeoutMs: 30_000,
  },
);
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
const shot = await runProcess([
  "podman",
  "exec",
  "--workdir",
  "/home/agent",
  name,
  "scrot",
  "--pointer",
  "--overwrite",
  "--silent",
  "/dev/stdout",
]);
log(
  shot.success
    ? `screenshot: ${shot.stdout.byteLength} bytes (PNG signature ${new Uint8Array(
        shot.stdout.slice(0, 4),
      ).join(",")})`
    : `screenshot FAILED: ${new TextDecoder().decode(shot.stderr)}`,
);

// The semantic tools the agent gets (vm_find / vm_do / vm_wait): one real
// call through the same seam the tool uses, so a machine whose accessibility
// bus, gsettings flag or helper is wrong fails here rather than in a
// conversation.
const [find] = createVmSemanticTools({ exec });
if (find === undefined) throw new Error("the semantic tool set is empty");
const found = await find.execute(
  "probe",
  { app: "chromium", actionable: "yes", limit: 5 },
  undefined,
);
log(
  `vm_find: ${
    found.content[0]?.type === "text"
      ? found.content[0].text.split("\n")[0]
      : "(no text)"
  }`,
);

// 4. Stop it (unless asked to keep it for manual poking).
if (!noStop) {
  await vm.stop();
  log("\nmachine stopped.");
} else {
  log("\n(--no-stop: the machine is left running)");
  log(`  screen: podman port ${name} 6080`);
}
