/**
 * Platform dispatch for the computer host. One place decides whether this
 * machine can be driven at all, so every consumer (the server's startup log,
 * the settings toggle's error text, the tools' availability gate) reports
 * the same reason.
 *
 * A platform without a host implementation returns a reason instead of a
 * host: the tools are then never seeded and the built-in computer-use skill
 * is never advertised, so an agent is not pointed at a dead end.
 */
import type { ComputerHostResult } from "./types.ts";
import { createWindowsComputerHost } from "./windows.ts";

/** The computer host of this machine, or why there is none. */
export function createComputerHost(): ComputerHostResult {
  if (Deno.build.os !== "windows") {
    return {
      available: false,
      reason:
        `computer use is not supported on this platform yet (${Deno.build.os})`,
    };
  }
  return createWindowsComputerHost();
}
