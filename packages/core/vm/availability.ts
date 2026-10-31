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
import type { VmStatus } from "./container.ts";

export type StellaAvailability =
  | { available: true }
  /** `reason` is a full sentence shown to the user: which prerequisite is
   * missing and what to do about it. */
  | { available: false; reason: string };
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
    case "image_missing":
    case "image_stale":
    case "container_missing":
    case "stopped":
    case "running":
      return { available: true };
  }
}
