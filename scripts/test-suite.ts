/**
 * Run one of the two test suites.
 *
 * Usage:
 *   bun run scripts/test-suite.ts unit
 *   bun run scripts/test-suite.ts integration
 *
 * `unit` runs every test file that `scripts/test-suites.ts` does not list as
 * integration, as a single `bun test` invocation. `integration` runs the
 * listed files, one `bun test` per file when `--serial` is given.
 *
 * Parallelism: `LUMISCA_TEST_CONCURRENCY` (a number of worker processes, or
 * `1` for no parallelism) overrides the default. `--serial` on the
 * integration suite runs one file at a time regardless; that is the switch
 * to reach for when a podman or port test collides with another file.
 *
 * The exit code is `bun test`'s. `--list` prints what would run and exits 0,
 * so CI and a developer can see the split without running anything.
 */

import { exit } from "../packages/core/process.ts";
import { repoRoot } from "./lib.ts";
import {
  discoverTestFiles,
  INTEGRATION_SUITE,
  partitionTestFiles,
} from "./test-suites.ts";

/** Default worker count. `bun test --parallel` without a value uses the CPU
 * count, which on a CI runner also carries the other matrix jobs' 4 vCPUs
 * of neighbours; leaving two cores free keeps the timeout from firing. */
const DEFAULT_CONCURRENCY = 4;

type Suite = "unit" | "integration";

function usage(message?: string): never {
  if (message !== undefined) console.error(`test-suite: ${message}`);
  console.log(
    "usage: bun run scripts/test-suite.ts unit|integration [--serial] [--list]",
  );
  exit(message === undefined ? 0 : 1);
}

function concurrency(): number {
  const raw = process.env["LUMISCA_TEST_CONCURRENCY"];
  if (raw === undefined) return DEFAULT_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    usage(`LUMISCA_TEST_CONCURRENCY must be a positive integer, got "${raw}"`);
  }
  return value;
}

/** `bun test` argument list for one suite. `--parallel=N` is explicit so the
 * worker count is the same on every machine; `--timeout` stays at the 30s
 * the old `test` script used, because a podman pull legitimately takes that
 * long on a cold cache. */
function testArgs(files: readonly string[], workers: number): string[] {
  return ["test", `--parallel=${workers}`, "--timeout", "30000", ...files];
}

/** Run `bun test` over `files` once and return its exit code. */
async function runOnce(
  files: readonly string[],
  workers: number,
): Promise<number> {
  const child = Bun.spawn(["bun", ...testArgs(files, workers)], {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

/** Run each file in its own `bun test` process, one after another, stopping
 * at the first failure. A port-bound or podman test that collides with a
 * neighbour gets the machine to itself this way. */
async function runSerial(files: readonly string[]): Promise<number> {
  for (const [index, file] of files.entries()) {
    console.log(`\n[${index + 1}/${files.length}] ${file}`);
    const code = await runOnce([file], 1);
    if (code !== 0) return code;
  }
  return 0;
}

const [suiteArg, ...flags] = process.argv.slice(2);
if (suiteArg !== "unit" && suiteArg !== "integration") {
  usage(
    suiteArg === undefined
      ? "a suite is required"
      : `unknown suite: ${suiteArg}`,
  );
}
const suite: Suite = suiteArg;
const unknown = flags.filter((f) => f !== "--serial" && f !== "--list");
if (unknown.length > 0) usage(`unknown argument: ${unknown[0]}`);
const listOnly = flags.includes("--list");
const serial = flags.includes("--serial");
if (serial && suite === "unit") {
  // One process per unit file costs a bun startup per file (~120ms × 259)
  // and buys nothing: a unit test that collides with another is a bug to
  // fix, not something to schedule around.
  usage("--serial is only for the integration suite");
}

const split = partitionTestFiles(
  discoverTestFiles(repoRoot),
  INTEGRATION_SUITE,
);
if (split.stale.length > 0) {
  console.error(
    `test-suites.ts lists files that are not in the tree (delete them):\n  ${split.stale.join("\n  ")}`,
  );
  exit(1);
}
const files = suite === "unit" ? split.unit : split.integration;
if (files.length === 0) {
  console.error(`test-suite: the ${suite} suite matched no files`);
  exit(1);
}
if (listOnly) {
  console.log(`${suite}: ${files.length} files`);
  console.log(files.join("\n"));
  exit(0);
}

const workers = concurrency();
console.log(
  `${suite}: ${files.length} files, ${suite === "integration" && serial ? "one at a time" : `${workers} workers`} (LUMISCA_TEST_CONCURRENCY=${workers})`,
);
exit(
  suite === "integration" && serial
    ? await runSerial(files)
    : await runOnce(files, workers),
);
