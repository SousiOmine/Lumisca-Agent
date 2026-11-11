/**
 * The page's share of file drag and drop.
 *
 * The composer takes dropped files; nothing else on the page does. Without
 * this guard the browser's default action for a drop it was not asked to
 * handle is to open the file in place of the page — in the desktop shell that
 * is a window with no address bar and no way back to the app. The shell hands
 * file drops to the page for exactly this (tauri.conf.json's
 * `dragDropEnabled` is false), so the page has to be the one that refuses the
 * ones it does not use.
 *
 * Only drags that carry files are consumed. Dragging text into a field, or
 * reordering an element, is the browser's own business.
 */

/**
 * The parts of a drag event the guard reads.
 *
 * Structural rather than `DragEvent` so the rule stays a plain function the
 * tests can call with object literals (the same shape as
 * `useBackspaceGuard`'s target).
 */
export interface FileDragEvent {
  readonly dataTransfer: { readonly types: readonly string[] } | null;
  preventDefault(): void;
}

/** Whether this drag carries files. `types` is absent on a drag the page
 * started itself and on some synthetic events. */
export function carriesFiles(types: readonly string[] | undefined): boolean {
  return types?.includes("Files") === true;
}

/** Cancel a file drag: no default action, so the window stays where it is.
 * A drop the composer handles cancels the same event for the same reason. */
export function consumeFileDrag(event: FileDragEvent): void {
  if (carriesFiles(event.dataTransfer?.types)) event.preventDefault();
}

/**
 * Refuse file drops the page does not handle, for the whole document.
 *
 * The composer's own listeners run first (they are on the drop target), so
 * this never takes a drop away from it: it only stops the ones that reach the
 * document from turning into navigation.
 */
export function installFileDropGuard(target: Document): void {
  target.addEventListener("dragover", consumeFileDrag);
  target.addEventListener("drop", consumeFileDrag);
}
