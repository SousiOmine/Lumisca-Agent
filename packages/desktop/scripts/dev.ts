// The runtime API this script's Command/args/exit calls resolve to.

import { fileURLToPath } from "node:url";
import { exit, runtime } from "../../core/runtime/runtime.ts";
// The dependency-free half of the server startup, not startup.ts: this
// directory is outside the workspace, so the root import map (and therefore
// `@lumisca/core`) is unavailable to anything reached from here.
import { consumeServerStartupEnvironment } from "../../server/startup-env.ts";

// A released Lumisca server launches coding tools with its own process
// environment. Scrub that server-instance configuration before Tauri starts,
// so this repository can bootstrap its development desktop even when the
// hosting release predates server-side environment isolation.
consumeServerStartupEnvironment();

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const npm = runtime.build.os === "windows" ? "npm.cmd" : "npm";
const child = new runtime.Command(npm, {
  args: ["run", "tauri", "--", "dev", ...runtime.args],
  cwd: desktopRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

const status = await child.status;
exit(status.code);
