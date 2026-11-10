import {
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "preact/compat";

/**
 * Which side a `Select` list opens on, measured per opening.
 *
 * It used to be a caller's guess (`placement="above"` for a control on the
 * window's bottom edge, `"below"` everywhere else) plus the stylesheet's
 * `max-height`. Both assumptions failed in the same place: the thinking
 * control of the agent edit dialog sits near the bottom of a dialog, and the
 * dialog is the list's clipping box (`.modal { overflow-y: auto }`) — so the
 * list opened downward into the dialog's edge and was cut mid-row.
 *
 * What a caller knows is a preference ("below, unless there is no room"); the
 * room is a measurement, and it belongs here. The clip is not the window: a
 * list inside a dialog, a settings body or the chat column is clipped by the
 * nearest scrolling ancestor, so the room is computed against that box (see
 * `clipBandOf`).
 */

/** Distance kept between the trigger, the clip edge and the list. Mirrors the
 * stylesheet's offset (`top: calc(100% + 4px)` in .select-popover). */
export const SELECT_GAP = 4;

/** The side a list opens on. */
export type SelectSide = "above" | "below";

/** One vertical band, in client coordinates. */
export interface Band {
  top: number;
  bottom: number;
}

export interface SelectPlacement {
  /** The side the list is drawn on. */
  side: SelectSide;
  /**
   * The height the list may take, or null when the stylesheet's cap already
   * fits. A list with this cap scrolls inside it — it is never cut off, which
   * is the difference the user sees.
   */
  maxHeight: number | null;
}

/**
 * Place the list on `preferred`, moving to the other side when the preferred
 * one cannot hold it and the other has more room.
 *
 * `height` is the list's own height as the stylesheet sized it (its cap
 * included), so a catalog longer than the cap does not flip a list that would
 * have fitted.
 */
export function chooseSelectSide(
  trigger: Band,
  clip: Band,
  height: number,
  preferred: SelectSide,
): SelectPlacement {
  const room: Record<SelectSide, number> = {
    above: Math.max(0, trigger.top - clip.top - SELECT_GAP),
    below: Math.max(0, clip.bottom - trigger.bottom - SELECT_GAP),
  };
  const other: SelectSide = preferred === "above" ? "below" : "above";
  const side = room[preferred] < height && room[other] > room[preferred]
    ? other
    : preferred;
  const available = room[side];
  // Neither side holds the list (a clip shorter than the list): the side with
  // more room, capped, scrolls. A capped list says there is more; a cut one
  // looks broken.
  return {
    side,
    maxHeight: available < height ? available : null,
  };
}

/** The part of the window the user can see, in client coordinates. The
 * visual viewport is the window while a software keyboard is open. */
function visibleBand(): Band {
  const viewport = globalThis.visualViewport;
  return viewport === null || viewport === undefined
    ? { top: 0, bottom: globalThis.innerHeight }
    : { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height };
}

function bandOf(rect: { top: number; bottom: number }): Band {
  return { top: rect.top, bottom: rect.bottom };
}

/**
 * The box that clips `element`: the nearest ancestor that scrolls or hides its
 * overflow, intersected with what is visible. A list is cut exactly at that
 * edge, not at the window's, so that is the room worth measuring.
 */
export function clipBandOf(element: HTMLElement | null): Band {
  const visible = visibleBand();
  let node = element?.parentElement ?? null;
  while (node !== null) {
    // A clipping box in either axis is the edge the list can be cut at; the
    // vertical part is what the placement reads.
    if (getComputedStyle(node).overflowY !== "visible") {
      const rect = bandOf(node.getBoundingClientRect());
      return {
        top: Math.max(rect.top, visible.top),
        bottom: Math.min(rect.bottom, visible.bottom),
      };
    }
    node = node.parentElement;
  }
  return visible;
}

function samePlacement(
  a: SelectPlacement,
  b: SelectPlacement,
): boolean {
  return a.side === b.side && a.maxHeight === b.maxHeight;
}

/**
 * Track where a `Select` list may open while it is open.
 *
 * `list` is the popover itself: its height is what has to fit. It is measured
 * once per opening, before the cap is applied — a capped list measured again
 * would report the cap as its height, "fit", lose the cap, and flicker.
 *
 * The measurement runs in a layout effect, so the first painted frame is
 * already the placed one. While the list is closed nothing is measured; the
 * next opening measures again (the window, the dialog or the option list may
 * have changed in between).
 */
export function useSelectPlacement(
  trigger: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  open: boolean,
  preferred: SelectSide,
  optionCount: number,
): SelectPlacement {
  const [placement, setPlacement] = useState<SelectPlacement>({
    side: preferred,
    maxHeight: null,
  });
  /** The list's own height (see the doc above); null = measure on the next
   * pass. */
  const height = useRef<number | null>(null);
  const measuredCount = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      height.current = null;
      measuredCount.current = null;
      return;
    }
    if (measuredCount.current !== optionCount) {
      height.current = null;
      measuredCount.current = optionCount;
    }
    const update = () => {
      const triggerElement = trigger.current;
      const listElement = list.current;
      if (triggerElement === null || listElement === null) return;
      height.current ??= listElement.getBoundingClientRect().height;
      const next = chooseSelectSide(
        bandOf(triggerElement.getBoundingClientRect()),
        clipBandOf(triggerElement),
        height.current,
        preferred,
      );
      setPlacement((previous) =>
        samePlacement(previous, next) ? previous : next
      );
    };
    update();

    // Layout changes arrive in bursts (a resize, a keyboard, a scroll of an
    // ancestor); one measurement per frame is plenty.
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    const viewport = globalThis.visualViewport;
    globalThis.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      globalThis.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [open, preferred, optionCount, trigger, list]);

  return placement;
}
