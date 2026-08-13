import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useState,
} from "react";

/** Pixel position of the caret within the textarea (mirror-div technique:
 * clone the textarea's metrics, render the text up to the caret, and read
 * where a marker span lands). The marker's rect is offset by the mirror's
 * own rect, so the result is relative to the mirror — and, because the
 * textarea and its wrapper share a top-left origin, to the popover's
 * containing block — regardless of any transform on an ancestor. */
function measureCaret(
  textarea: HTMLTextAreaElement,
): { x: number; y: number } {
  const pos = textarea.selectionStart;
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const props = [
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "wordSpacing",
    "textIndent",
    "textTransform",
  ] as const;
  for (const prop of props) {
    mirror.style.setProperty(prop, style.getPropertyValue(prop));
  }
  mirror.style.position = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.left = "0";
  mirror.style.top = "0";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordBreak = "break-word";
  const before = textarea.value.slice(0, pos);
  mirror.textContent = before;
  if (before.endsWith("\n")) mirror.appendChild(document.createElement("br"));
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(pos) || " ";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  document.body.removeChild(mirror);
  return {
    x: markerRect.left - mirrorRect.left,
    y: markerRect.top - mirrorRect.top,
  };
}

/** Caret measurement for popover positioning. The mirror-div technique
 * needs the live textarea (its metrics and the text up to the caret), so
 * the measurement is triggered imperatively from the input handlers via
 * `measure`; `setCaretPos` lets callers clear the marker when the popover
 * closes. */
export function useCaretPosition(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): {
  caretPos: { x: number; y: number } | null;
  setCaretPos: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  /** Measure the caret of the textarea (no-op while it is unmounted). */
  measure: () => void;
} {
  const [caretPos, setCaretPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const measure = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) setCaretPos(measureCaret(ta));
  }, [textareaRef]);
  return { caretPos, setCaretPos, measure };
}
