import { fileURLToPath } from "node:url";
import { OS } from "../../core/platform.ts";
import { exit, spawnProcess } from "../../core/process.ts";
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
const npm = OS === "windows" ? "npm.cmd" : "npm";
const child = spawnProcess(
  [npm, "run", "tauri", "--", "dev", ...process.argv.slice(2)],
  {
    cwd: desktopRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

exit(await child.exited);
