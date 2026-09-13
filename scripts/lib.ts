/**
 * Helpers shared by the build/release scripts. Everything here exists
 * because a second copy drifted or would drift:
 *
 * - `repoRoot` is computed once. Two spellings of it already existed
 *   (`fileURLToPath` vs. a hand-rolled `.pathname` conversion), and the
 *   hand-rolled one silently fails on a path containing a space — a
 *   mismatch that would only surface when someone tags a release from such
 *   a checkout.
 * - `binaryName` is the per-platform constant the build and smoke scripts
 *   must agree on, and `reportUsage` is the exit contract every script
 *   shares (message → stderr + exit 1, bare `--help` → stdout + exit 0).
 * - `parseOptions` is the `--key value` reader the manifest and archive
 *   scripts share.
 * - `createChecker` is the `ok/FAIL` reporter the archive and smoke scripts
 *   share, including the failure accumulation the exit code comes from.
 */
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root. This file lives in `scripts/`, so the root is one
 * directory up. `fileURLToPath` (not `.pathname`) so a repository path
 * containing spaces or non-ASCII characters resolves correctly. */
export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Name of the server binary on this platform (`deno compile` and the
 * desktop shell both expect the `.exe` suffix on Windows). */
export function binaryName(): string {
  return Deno.build.os === "windows" ? "lumisca-server.exe" : "lumisca-server";
}

/** One script's usage handler. `usage("--out needs a directory")` reports
 * the problem and exits 1; `usage()` (an explicit `--help`) prints the
 * usage line alone and exits 0. */
export type Usage = (message?: string) => never;

/** Print a script's usage and exit: the error message to stderr with exit
 * 1, or the usage line alone to stdout with exit 0 (`--help`).
 *
 * Each script wraps this in a `function usage(message?: string): never`
 * declaration of its own. A `const usage = reportUsage.bind(...)` alias
 * would type-check too, but TypeScript only ends the control flow after a
 * `never`-returning call when the callee is a declaration — with a `const`
 * alias, `if (x === undefined) usage()` leaves `x` narrowed as `undefined`
 * and the next line fails to compile. */
export function reportUsage(
  script: string,
  line: string,
  message?: string,
): never {
  if (message !== undefined) console.error(`${script}: ${message}`);
  console.log(`usage: ${line}`);
  Deno.exit(message === undefined ? 0 : 1);
}

/** Parse `--key value` pairs into a map keyed without the leading `--`.
 * An unknown flag, a bare positional, a missing value and a value that
 * looks like the next flag all go through `usage` — a mistyped invocation
 * must not silently read one argument as another. */
export function parseOptions(
  args: readonly string[],
  usage: Usage,
): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) usage(`unknown argument: ${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      usage(`${arg} needs a value`);
    }
    values.set(arg.slice(2), value);
    i++;
  }
  return values;
}

/** Resolve a caller-supplied path against the working directory, so a
 * relative argument means what the shell that typed it means. */
export function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(Deno.cwd(), path);
}

/** The `ok/FAIL` reporter shared by the verification scripts: each check
 * prints one line, failures accumulate, and the caller reports them and
 * exits 1 when the list is non-empty. */
export interface Checker {
  check(name: string, ok: boolean, detail?: string): void;
  /** Names of the checks that failed, in the order they ran. */
  readonly failures: string[];
}

export function createChecker(): Checker {
  const failures: string[] = [];
  return {
    check(name, ok, detail = "") {
      console.log(
        `${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`,
      );
      if (!ok) failures.push(name);
    },
    failures,
  };
}
