/**
 * Smoke test for a packaged Lumisca server (the artifact
 * scripts/build-server.ts produces): start the binary the way a user would
 * — no LUMISCA_ASSETS_FILE, only a port and a database in a temporary
 * directory — wait for /api/health, fetch the page and its assets, then
 * stop it again. CI runs this right after the build on every platform, so a
 * broken package fails there instead of at a pushed tag.
 *
 * Usage:
 *   deno run --allow-all scripts/smoke-server.ts [--bin <path>]
 *
 * Without `--bin` the staged release build of this host is used
 * (dist/server/stage/<deno target>/lumisca-server[.exe]).
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_STARTUP_ENV_KEYS } from "../packages/server/startup.ts";

// This script lives in scripts/; the repo root is one level up.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** How long the server may take to answer /api/health (a cold packaged
 * server answers in well under a second; the budget covers a busy runner). */
const HEALTH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
/** How long a graceful shutdown may take before the process is killed. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

function usage(message?: string): never {
  const stream = message === undefined ? console.log : console.error;
  if (message !== undefined) console.error(`smoke-server: ${message}`);
  stream(
    "usage: deno run --allow-all scripts/smoke-server.ts [--bin <path>]",
  );
  Deno.exit(message === undefined ? 0 : 1);
}

function binaryName(): string {
  return Deno.build.os === "windows" ? "lumisca-server.exe" : "lumisca-server";
}

/** Staged release build for this host (see scripts/build-server.ts). */
function defaultBinary(): string {
  return join(
    repoRoot,
    "dist",
    "server",
    "stage",
    Deno.build.target,
    binaryName(),
  );
}

function parseArgs(args: readonly string[]): string {
  let bin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--bin") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        usage("--bin needs a path");
      }
      bin = value;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  if (bin === undefined) return defaultBinary();
  return isAbsolute(bin) ? bin : resolve(Deno.cwd(), bin);
}

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A port the OS just handed out and released, so the server can bind it.
 * (A pre-bound port cannot be inherited by the child, and LUMISCA_PORT
 * rejects 0.) */
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** Stop the server and wait for it: SIGTERM on POSIX (the server shuts
 * down gracefully), a tree kill on Windows (it has no signal handling
 * there, and tool processes must not outlive it). */
async function stop(child: Deno.ChildProcess, status: Promise<unknown>) {
  if (Deno.build.os === "windows") {
    await new Deno.Command("taskkill", {
      args: ["/PID", String(child.pid), "/T", "/F"],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => {});
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited between the request and the signal.
    }
  }
  const stopped = await Promise.race([
    status.then(() => true),
    delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (!stopped) {
    console.error("smoke-server: the server did not stop; killing it");
    try {
      child.kill("SIGKILL");
    } catch {
      // Nothing left to kill.
    }
    await status;
  }
}

const binary = parseArgs(Deno.args);
try {
  if (!(await Deno.stat(binary)).isFile) {
    usage(`not a file: ${binary}`);
  }
} catch {
  usage(`server binary not found: ${binary} (run deno task build:server)`);
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const port = freePort();
const base = `http://127.0.0.1:${port}`;
const workDir = await Deno.makeTempDir({ prefix: "lumisca-smoke-" });

// Deno.Command inherits the parent environment and `env` only adds to /
// overrides it, so a LUMISCA_ASSETS_FILE (or any other startup value) in the
// caller's environment would leak into the child and defeat this check:
// `clearEnv` hands the child exactly `childEnv`, with the launcher-only keys
// removed. The packaged server must find everything it needs beside its own
// binary.
const childEnv = Deno.env.toObject();
for (const key of SERVER_STARTUP_ENV_KEYS) delete childEnv[key];
childEnv.LUMISCA_PORT = String(port);
childEnv.LUMISCA_DB = join(workDir, "smoke.db");

console.log(`Starting ${binary} on ${base}`);
const child = new Deno.Command(binary, {
  // Run from the directory the package was extracted into, like a user
  // following the release notes would.
  cwd: dirname(binary),
  env: childEnv,
  clearEnv: true,
  stdin: "null",
  stdout: "piped",
  stderr: "piped",
}).spawn();
const statusPromise = child.status;
const outputPromise = (async () => {
  const read = (stream: ReadableStream<Uint8Array> | null) =>
    stream === null ? Promise.resolve("") : new Response(stream).text();
  const [out, err] = await Promise.all([
    read(child.stdout),
    read(child.stderr),
  ]);
  return `${out}${err}`;
})();

try {
  let healthy = false;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(POLL_INTERVAL_MS);
  }
  check("/api/health answers", healthy, base);

  if (healthy) {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    check(
      "GET / serves the app shell",
      page.status === 200 && html.includes("<html") &&
        html.includes("/assets/app.js"),
      `status ${page.status}, ${html.length} bytes`,
    );

    const appJs = await fetch(`${base}/assets/app.js`);
    const appJsText = await appJs.text();
    check(
      "GET /assets/app.js serves the bundled client",
      appJs.status === 200 && appJsText.length > 10_000,
      `status ${appJs.status}, ${appJsText.length} bytes`,
    );

    const css = await fetch(`${base}/styles.css`);
    const cssText = await css.text();
    check(
      "GET /styles.css serves the stylesheet",
      css.status === 200 && cssText.length > 1_000,
      `status ${css.status}, ${cssText.length} bytes`,
    );

    const data = await fetch(`${base}/assets/initial-data.js`);
    const dataText = await data.text();
    check(
      "GET /assets/initial-data.js serves the bootstrap data",
      data.status === 200 && dataText.includes("__INITIAL_DATA__"),
      `status ${data.status}`,
    );

    const favicon = await fetch(`${base}/favicon.png`);
    check(
      "GET /favicon.png serves the icon",
      favicon.status === 200 &&
        (favicon.headers.get("content-type") ?? "").includes("image/png"),
      `status ${favicon.status}`,
    );
    await favicon.body?.cancel();
  }
} finally {
  await stop(child, statusPromise);
  const serverOutput = (await outputPromise).trim();
  if (failures.length > 0 && serverOutput !== "") {
    console.error(`--- server output ---\n${serverOutput}\n--- end ---`);
  }
  await Deno.remove(workDir, { recursive: true }).catch(() => {});
}

if (failures.length > 0) {
  console.error(`smoke-server: FAILED (${failures.join("; ")})`);
  Deno.exit(1);
}
console.log("smoke-server: packaged server serves the UI");
