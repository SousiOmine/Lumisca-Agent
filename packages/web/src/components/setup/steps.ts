/**
 * The first-run setup's screens, and the moves between them.
 *
 * The order is a value, not a chain of conditionals: the header's progress
 * line, the footer's buttons and the body all read it, so a screen cannot be
 * reachable by one of them and not by the others.
 *
 * A screen is not a place: the wizard has one address (`/setup`, see
 * route.ts), and each screen's choices are written into the settings as they
 * are made. Reloading therefore restarts at the first screen with everything
 * already chosen, which costs the reader one press and keeps the address
 * honest.
 */

/** The local walk: every screen that sets THIS server up. A browser page has
 * only these, because it has no bridge to switch the window to another
 * server with. */
export const LOCAL_STEPS = ["welcome", "provider", "model", "done"] as const;

export type LocalStep = (typeof LOCAL_STEPS)[number];

/** Every screen of the wizard. `server` is the desktop app's gate: the
 * window can display another server, so the setup asks which one first. */
export type SetupStep = "server" | LocalStep;

/**
 * The screens this window walks, in reading order (never empty).
 *
 * The desktop shell can switch the displayed server through its bridge, so
 * its setup opens on the connection screen and keeps the local walk behind
 * it. A plain browser has no bridge: switching servers there would mean
 * leaving the page, which is the address bar's job, so it starts on the local
 * walk.
 */
export function setupSteps(
  desktop: boolean,
): readonly [SetupStep, ...SetupStep[]] {
  return desktop ? ["server", ...LOCAL_STEPS] : LOCAL_STEPS;
}

/** The screen after `step` in `steps`, or null at the end. Null also for a
 * step that is not in this window's walk. */
export function nextStep(
  steps: readonly SetupStep[],
  step: SetupStep,
): SetupStep | null {
  const index = steps.indexOf(step);
  return index < 0 ? null : (steps[index + 1] ?? null);
}

/** The screen before `step` in `steps`, or null at the start. */
export function previousStep(
  steps: readonly SetupStep[],
  step: SetupStep,
): SetupStep | null {
  const index = steps.indexOf(step);
  return index <= 0 ? null : (steps[index - 1] ?? null);
}

/** Where `step` is in the local walk, counting from 1; null for the
 * connection screen, which is the gate before the walk and not one of the
 * four steps the progress line counts. */
export function stepNumber(step: SetupStep): number | null {
  const index = (LOCAL_STEPS as readonly string[]).indexOf(step);
  return index < 0 ? null : index + 1;
}

/** Whether `step` is the last one: its primary button finishes the wizard
 * instead of moving on. */
export function isLastStep(step: SetupStep): boolean {
  return step === LOCAL_STEPS[LOCAL_STEPS.length - 1];
}
