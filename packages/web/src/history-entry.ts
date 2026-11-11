import type { UrlState } from "./route.ts";

/**
 * What entries this app pushes write to `history.state`, and what a move back
 * reads from it.
 *
 * The URL says which screen an entry shows; it cannot say where that entry
 * sits in the stack. That matters for closing the settings dialog: the dialog
 * covers the screen it was opened from, but a reader who picked three
 * categories on the way is three entries above it. Closing is one intent and
 * must be one move, so each entry records how many entries the dialog sits
 * above.
 *
 * This is not a second answer to "where am I" — the address still is. It is
 * only the shape of the stack behind the address, which is `history`'s own
 * state and belongs with the only module that touches `history`.
 */

/** Marks an entry this app pushed. A replace keeps the marker it finds, so
 * an entry the app rewrote is still one to come back to. */
export const APP_ENTRY = "lumisca";

/** The number of entries the settings dialog sits above: 0 on an entry with
 * no dialog over it. */
export const DIALOG_DEPTH = "lumiscaDialogDepth";

/** The `history.state` of an entry pushed from `parent` (the state of the
 * entry being left) to show `next`. */
export function pushedState(
  parent: unknown,
  next: UrlState,
): Record<string, unknown> {
  return {
    [APP_ENTRY]: true,
    [DIALOG_DEPTH]: next.settings === null ? 0 : dialogDepth(parent) + 1,
  };
}

/**
 * The `history.state` of an entry replaced with `next`.
 *
 * A replace is not a place: the entry keeps the marker it had, and it drops
 * the dialog's depth when the new address names no dialog. Keeping the old
 * depth would make the next close walk back over the entries a different
 * dialog had opened, past the screen it was opened from.
 */
export function replacedState(current: unknown, next: UrlState): unknown {
  if (!isAppEntry(current)) return current;
  if (next.settings !== null) return current;
  return { ...read(current), [DIALOG_DEPTH]: 0 };
}

/** Whether the entry was pushed (or replaced in place) by this app. */
export function isAppEntry(state: unknown): boolean {
  return read(state)?.[APP_ENTRY] === true;
}

/** How many entries the settings dialog sits above on this entry; 0 when it
 * is not open. A state this app did not write, or one with a value that is
 * not a positive integer, answers 0: the caller then falls back to one step
 * rather than skipping an unknown number. */
export function dialogDepth(state: unknown): number {
  const depth = read(state)?.[DIALOG_DEPTH];
  return typeof depth === "number" && Number.isInteger(depth) && depth > 0
    ? depth
    : 0;
}

/**
 * How many entries one `dismiss` walks back.
 *
 * Closing the dialog (`next` names none) reaches the screen it covered, no
 * matter how many pages were opened inside it. One step would land on the
 * dialog's previous page — whose exit has already run, leaving the invisible
 * backdrop over the app and the address still naming the dialog. A step
 * inside the dialog, or a back on a screen with no dialog, is one entry.
 */
export function dismissSteps(depth: number, next: UrlState): number {
  return next.settings === null ? Math.max(1, depth) : 1;
}

function read(state: unknown): Record<string, unknown> | null {
  return state !== null && typeof state === "object"
    ? (state as Record<string, unknown>)
    : null;
}
