import { fileURLToPath } from "node:url";
import { consumeServerStartupEnvironment } from "../../server/startup.ts";

// A released Lumisca server launches coding tools with its own process
// environment. Scrub that server-instance configuration before Tauri starts,
// so this repository can bootstrap its development desktop even when the
// hosting release predates server-side environment isolation.
consumeServerStartupEnvironment();

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const npm = Deno.build.os === "windows" ? "npm.cmd" : "npm";
const child = new Deno.Command(npm, {
  args: ["run", "tauri", "--", "dev", ...Deno.args],
  cwd: desktopRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

const status = await child.status;
Deno.exit(status.code);
