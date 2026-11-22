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

/** The `podman exec` argv for a command inside one machine. */
export function podmanExec(
  name: string,
  command: readonly string[],
  exec: {
    workdir?: string;
    interactive?: boolean;
    env?: Record<string, string>;
  } = {},
): string[] {
  return podman([
    "exec",
    ...(exec.interactive === true ? ["--interactive"] : []),
    ...Object.entries(exec.env ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--workdir",
    exec.workdir ?? VM_WORKDIR,
    name,
    ...command,
  ]);
}
