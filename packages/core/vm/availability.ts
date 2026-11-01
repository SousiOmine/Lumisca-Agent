/**
 * Whether stella mode can run on this machine.
 *
 * stella mode's promise is a machine the agent works inside, and there is no
 * version of that promise without podman. Rather than degrade into "a chat
 * with no VM" — an agent that silently loses its tools and tells the user it
 * cannot do the work — the mode is not offered at all, with the reason shown
 * where the mode would be picked. The caller (the mode-selection screen) has
 * no fallback path to take: it renders the reason.
 */
import type { StellaAvailability } from "../shared/wire.ts";
import type { VmStatus } from "./container.ts";

// Importers of the verdict's type reach it through this module (the one that
// decides it) and through `@lumisca/core/shared` (the web bundle); both name
// the definition in shared/wire.ts.
export type { StellaAvailability };

/** Turn the machine's status into the availability verdict. Only the
 * prerequisites are judged here — whether the image has been built yet is
 * not a reason to hide the mode: starting the machine builds it. */
export function stellaAvailability(status: VmStatus): StellaAvailability {
  switch (status.state) {
    case "podman_missing":
      return {
        available: false,
        reason:
          `stella mode needs podman, and it is not usable on this machine ` +
          `(${status.reason}). Install podman (rootless) and restart Lumisca, ` +
          "or use code mode.",
      };
    case "podman_unusable":
      // podman answers, so the old check said "available" and the machine
      // was offered — then failed minutes into an image build with a message
      // about kernel files that says nothing to the person reading it. The
      // host cannot run a container at all, and no setting changes that.
      return {
        available: false,
        reason:
          `stella mode runs the agent inside a container, and this host ` +
          `cannot start one (${status.reason}). It is a limit of the ` +
          "environment Lumisca is running in, not of its settings — a " +
          "container nested in a sandbox without the privileges to nest one. " +
          "Use code mode.",
      };
    case "image_missing":
    case "image_stale":
    case "container_missing":
    case "stopped":
    case "running":
      return { available: true };
  }
}
