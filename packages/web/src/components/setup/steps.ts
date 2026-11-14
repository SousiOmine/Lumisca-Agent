/**
 * The first-run setup's steps, and the moves between them.
 *
 * The order is a value, not a chain of conditionals: the header's progress
 * line, the footer's buttons and the body all read it, so a step cannot be
 * reachable by one of them and not by the others.
 *
 * A step is not a place: the wizard has one address (`/setup`, see route.ts),
 * and each step's choices are written into the settings as they are made.
 * Reloading therefore restarts at the first step with everything already
 * chosen, which costs the reader one press and keeps the address honest.
 */

/** The steps, in reading order. */
export const SETUP_STEPS = ["welcome", "provider", "model", "done"] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/** The step after `step`, or null on the last one (the wizard finishes
 * there). */
export function nextStep(step: SetupStep): SetupStep | null {
  return SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1] ?? null;
}

/** The step before `step`, or null on the first one. */
export function previousStep(step: SetupStep): SetupStep | null {
  const index = SETUP_STEPS.indexOf(step);
  return index <= 0 ? null : (SETUP_STEPS[index - 1] ?? null);
}

/** Where `step` is in the walk, counting from 1 (the progress line). */
export function stepNumber(step: SetupStep): number {
  return SETUP_STEPS.indexOf(step) + 1;
}

/** Whether `step` is the last one: its primary button finishes the wizard
 * instead of moving on. */
export function isLastStep(step: SetupStep): boolean {
  return step === SETUP_STEPS[SETUP_STEPS.length - 1];
}
