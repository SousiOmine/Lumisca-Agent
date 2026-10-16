/**
 * Platform dispatch for the computer host. One place decides whether this
 * machine can be driven at all, so every consumer (the server's startup log,
 * the settings toggle's error text, the tools' availability gate) reports
 * the same reason.
 *
 * A platform without a host implementation returns a reason instead of a
 * host: the tools are then never seeded and the built-in computer-use skill
 * is never advertised, so an agent is not pointed at a dead end.
 *
 * Linux asks the desktop before it claims anything (see wayland.ts): the
 * check is a few D-Bus property reads, and it is what turns "this desktop
 * cannot be driven" into a sentence the settings dialog can show. That is
 * also why this function is asynchronous while the Windows path is not —
 * one signature for both keeps the callers single-path.
 */
import type { ComputerHostResult } from "./types.ts";
import {
  createWaylandComputerHost,
  type WaylandHostOptions,
} from "./wayland.ts";
import { createWindowsComputerHost } from "./windows.ts";

/** What a platform host may need to start: the Wayland host wants the
 * restore-token store (so a granted screen share survives a restart) and the
 * environment it checks; Windows needs nothing. */
export type ComputerHostOptions = WaylandHostOptions;

/** The computer host of this machine, or why there is none. */
export function createComputerHost(
  options: ComputerHostOptions = {},
): Promise<ComputerHostResult> {
  switch (Deno.build.os) {
    case "windows":
      return Promise.resolve(createWindowsComputerHost());
    case "linux":
      return createWaylandComputerHost(options);
    default:
      return Promise.resolve({
        available: false,
        reason:
          `computer use is not supported on this platform yet (${Deno.build.os})`,
      });
  }
}
