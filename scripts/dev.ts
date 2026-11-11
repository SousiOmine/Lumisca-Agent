/**
 * Run the server and the Vite dev server together, the way `deno task dev`
 * used to.
 *
 * The server is the product: it owns the API, the sessions and a client
 * built on the fly from the repository sources. Vite serves the same client
 * with hot reload, for the times a UI change needs to be seen without a
 * reload. Stopping either one stops both, so a crashed server cannot leave
 * a Vite server pointing at nothing.
 */
import { spawn } from "node:child_process";

const bun = process.execPath;
const children = [
  spawn(bun, ["run", "packages/server/mod.ts"], { stdio: "inherit" }),
  spawn(bun, ["x", "vite", "packages/web", "--configLoader", "native"], {
    stdio: "inherit",
  }),
];

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
for (const child of children) child.on("exit", (code) => stop(code ?? 0));
