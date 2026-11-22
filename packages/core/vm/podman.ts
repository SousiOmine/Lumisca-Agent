/**
 * How every module here asks `podman` something, and how a failed call is
 * turned into one sentence.
 *
 * The argv is the contract with the runtime: the status probe, the image
 * build, the lifecycle, the contract check and the exec seams the backends use
 * all go through these helpers, so the exec shape cannot drift between them.
 */

import { firstLine } from "../lines.ts";
import type { VmCommandResult } from "./command.ts";
import { VM_WORKDIR } from "./contract.ts";

/** The podman command prefix every call shares. */
export function podman(args: readonly string[]): string[] {
  return ["podman", ...args];
}

/** The sentence a failed command contributes: its stderr, else its stdout,
 * else the exit code. */
export function detail(result: VmCommandResult): string {
  const text = result.stderr.trim() || result.stdout.trim();
  return text === "" ? `exit code ${result.exitCode}` : firstLine(text);
}

/** What one `podman exec` call carries, whatever shape its output comes back
 * in: the working folder, whether the program reads stdin, and the
 * per-call environment. */
export interface ExecArgvOptions {
  /** The folder the command starts in (defaults to VM_WORKDIR). */
  workdir?: string;
  /** Whether the program's stdin stays open (`--interactive`). Required by
   * anything that writes to the program, and only by that. */
  interactive?: boolean;
  /** Environment variables for this call only (`--env`). */
  env?: Record<string, string>;
}

/**
 * The `podman exec` argv for a command inside one machine.
 *
 * The single place the exec argument shape is written: the text and byte
 * seams, the interactive channel the scripting tool keeps open, the desktop
 * helper, the contract probe and the screen probe all call this, so no
 * caller can invent a flag order or forget the workdir.
 */
export function execArgv(
  name: string,
  command: readonly string[],
  options: ExecArgvOptions = {},
): string[] {
  return podman([
    "exec",
    ...(options.interactive === true ? ["--interactive"] : []),
    ...Object.entries(options.env ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--workdir",
    options.workdir ?? VM_WORKDIR,
    name,
    ...command,
  ]);
}
