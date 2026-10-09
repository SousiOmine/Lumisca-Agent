import { useEffect } from "preact/compat";

/** The parts of a key event's target the Backspace rule reads. Structural
 * rather than `Element` so the rule stays a plain function the tests can
 * call with object literals. */
export interface BackspaceTarget {
  /** `Element.tagName`, as the DOM reports it (upper case). */
  tagName: string;
  /** `HTMLInputElement.type`; absent on every other element. */
  type?: string | null;
  /** `readOnly` of a text control. */
  readOnly?: boolean;
  disabled?: boolean;
  /** `HTMLElement.isContentEditable` (true inside an editable subtree). */
  isContentEditable?: boolean;
}

/** Input types whose value the user edits with the keyboard, i.e. where
 * Backspace is a text edit. Every other type (checkbox, radio, button,
 * range, file, color, ...) has no caret: Backspace cannot be an edit
 * there, so the key must not reach the WebView either. */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Whether Backspace at this target belongs to a text field. WebKit keeps
 * the key only when the selection is editable; anywhere else it is the
 * WebView's "go back" shortcut (see useBackspaceGuard). A read-only
 * control has nothing to delete, so it counts as "not an edit" — which is
 * also what WebKit does, and exactly the case that would navigate. */
export function isTextEditTarget(target: BackspaceTarget): boolean {
  if (target.disabled) return false;
  if (target.tagName === "TEXTAREA") return !target.readOnly;
  if (target.tagName === "INPUT") {
    return !target.readOnly && TEXT_INPUT_TYPES.has(target.type ?? "text");
  }
  return target.isContentEditable === true;
}

/** The parts of a key event the rule reads (structural, like the target). */
export interface BackspaceEvent {
  key: string;
  /** Set by a handler that already consumed the key. */
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** Whether the guard must swallow the default action of this key event —
 * the whole rule, as a plain function. */
export function shouldSwallowBackspace(
  event: BackspaceEvent,
  target: BackspaceTarget,
): boolean {
  if (event.key !== "Backspace" || event.defaultPrevented) return false;
  // Cmd/Ctrl/Alt+Backspace is a shortcut ("delete to line start", ...) and
  // WebKit navigates for none of them: nothing to guard.
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return !isTextEditTarget(target);
}

/** Read the rule's inputs off a real event target. */
function targetOf(target: EventTarget | null): BackspaceTarget {
  const element = target as Partial<HTMLInputElement> | null;
  return {
    tagName: element?.tagName ?? "",
    type: element?.type ?? null,
    readOnly: element?.readOnly ?? false,
    disabled: element?.disabled ?? false,
    isContentEditable: element?.isContentEditable ?? false,
  };
}

/** Keep Backspace from walking the WebView's history.
 *
 * WebKit on macOS turns an unhandled Backspace into "go back" (and
 * Shift+Backspace into "go forward" — `shouldNavigateBackOnBackspace()`
 * in the editing behavior). The key is only "unhandled" outside text
 * fields: with an editable selection the delete command consumes it. So
 * pressing Backspace while a button, a row or a piece of selected text
 * has focus — not a text field — navigates the page away. In a plain
 * browser that is an ordinary back, but in the desktop app it reloads the
 * page out from under the user: an open settings dialog closes and
 * everything typed into it (a server being added, a token, ...) is lost.
 *
 * The guard swallows that default action outside text fields, leaving the
 * editing path untouched: Backspace stays a text-editing key and nothing
 * else. A widget that wants the key for something else (the folder
 * browser's "go up") handles it first and calls `preventDefault()`, which
 * the guard respects.
 */
export function useBackspaceGuard(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldSwallowBackspace(event, targetOf(event.target))) {
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
