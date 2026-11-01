import { useLayoutEffect, useState } from "preact/compat";

/**
 * Placement of the model picker's popover.
 *
 * It used to be a card hung above its trigger by CSS (`bottom: 100%`) at a
 * fixed size, and the settings copy was clamped only after it had been laid
 * out. That holds only while the window is both tall and wide: a short window
 * pushed the card past the top of the screen (its first provider rows were
 * cut off), a narrow one pushed its right edge out, and a window short enough
 * could not show it at all. The room is measured here, per opening, against
 * the *visual* viewport — so the software keyboard, which shrinks the visual
 * viewport without resizing the page on iOS, counts as "no room" too.
 */

/** Width the popover takes when the viewport allows it. The default of
 * `--mp-width` (styles/tokens.css) matches. */
export const POPOVER_PREFERRED_WIDTH = 640;
/** Height the popover takes when the viewport allows it: the three panes at
 * their comfortable size. The default of `--mp-space` matches. */
export const POPOVER_PREFERRED_HEIGHT = 380;
/** Room below which the preferred side is given up when the other one has
 * more to offer, and below which neither side is used at all (the panel fills
 * the visible area): under this the panes are a sliver rather than a list. */
export const POPOVER_MIN_HEIGHT = 220;
/** Distance kept from the visible area's edges. */
export const POPOVER_MARGIN = 8;
/** Distance kept from the anchor (the trigger). */
export const POPOVER_GAP = 6;
/** Narrowest the three panes get by; narrower shows one pane at a time, and
 * also a phone (whose sheet is deliberately not wide enough for three columns:
 * provider, model id and its metadata side by side would leave the id
 * ellipsized to a few characters). */
export const PANES_MIN_WIDTH = 600;
/** Shortest the three panes get by. Low on purpose: in the three-pane layout
 * only the model list needs height (the thinking bar is a column), while the
 * stepped layout spends a header and a horizontal thinking rail before the list
 * gets any — so the panes keep winning far into "short window" territory. */
export const PANES_MIN_HEIGHT = 200;
/** Tallest the sheet grows to. It still shrinks to the visible area; the cap
 * only keeps a tall phone from turning it into a full-screen page. */
export const SHEET_MAX_HEIGHT = 620;

/** The side the caller would like to open on. `"below"` is for a trigger near
 * the top of the screen (the settings list). */
export type PopoverSide = "above" | "below";

/** The trigger, in client coordinates (getBoundingClientRect). */
export interface PopoverAnchor {
  top: number;
  bottom: number;
  left: number;
}

/** The slice of the page the user can see, in client coordinates. The visual
 * viewport reports exactly this shape (an offset inside the layout viewport
 * plus a size). */
export interface PopoverViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopoverFitInput {
  anchor: PopoverAnchor;
  viewport: PopoverViewport;
  /** Height of the layout viewport (documentElement.clientHeight): the
   * `bottom` of a fixed box counts from that edge, while the rectangles
   * above count from its top. */
  layoutHeight: number;
  prefer: PopoverSide;
}

export interface PopoverFit {
  /** The side the popover is actually placed on. */
  side: PopoverSide;
  /** Neither side holds a usable panel, so it fills the visible area instead
   * of hanging off its trigger (a window only a few hundred pixels tall). The
   * two offsets below then both name an edge. */
  fills: boolean;
  /** Fixed `left` (client coordinates). */
  left: number;
  /** Fixed `top`; `null` when the popover opens above its anchor — it is
   * anchored at the bottom then, so content shorter than the room still hugs
   * the trigger. */
  top: number | null;
  /** Fixed `bottom`; `null` when the popover opens below its anchor. */
  bottom: number | null;
  /** Width the popover takes (never wider than the visible area allows). */
  width: number;
  /** The most height the popover may take; shorter content stays shorter. */
  height: number;
}

/**
 * Place the popover on `prefer`, shrinking it to the room that is actually
 * there and moving to the other side when the preferred one cannot hold its
 * contents. It also keeps the popover inside the viewport horizontally:
 * anchored at the trigger's left edge it would otherwise run off the right
 * edge of a narrow window.
 */
export function fitPopover(
  { anchor, viewport, layoutHeight, prefer }: PopoverFitInput,
): PopoverFit {
  const visibleTop = viewport.top + POPOVER_MARGIN;
  const visibleBottom = viewport.top + viewport.height - POPOVER_MARGIN;
  // A trigger outside the visible slice (the software keyboard covered it, a
  // scroll moved it away) still gets a panel inside that slice: the anchor is
  // clamped to the edges, so the placement below never counts room that is not
  // on screen.
  const anchorTop = Math.min(Math.max(anchor.top, visibleTop), visibleBottom);
  const anchorBottom = Math.min(
    Math.max(anchor.bottom, visibleTop),
    visibleBottom,
  );
  // Room between the anchor and the visible edge on each side.
  const above = Math.max(0, anchorTop - POPOVER_GAP - visibleTop);
  const below = Math.max(0, visibleBottom - (anchorBottom + POPOVER_GAP));
  const room: Record<PopoverSide, number> = { above, below };

  const other: PopoverSide = prefer === "above" ? "below" : "above";
  const side = room[prefer] < POPOVER_MIN_HEIGHT && room[other] > room[prefer]
    ? other
    : prefer;
  // Neither side holds a panel worth showing (a window a few hundred pixels
  // tall): rather than a sliver of a list, the panel fills the visible area.
  // It is still an overlay the user can leave (outside click, Escape, the
  // stepped layout's close button), and a list with rows in it beats one with
  // none.
  if (room[side] < POPOVER_MIN_HEIGHT) {
    return {
      side,
      fills: true,
      left: viewport.left + POPOVER_MARGIN,
      top: visibleTop,
      bottom: layoutHeight - visibleBottom,
      width: Math.max(0, viewport.width - 2 * POPOVER_MARGIN),
      height: Math.max(0, visibleBottom - visibleTop),
    };
  }

  const width = Math.max(
    0,
    Math.min(POPOVER_PREFERRED_WIDTH, viewport.width - 2 * POPOVER_MARGIN),
  );
  // Stay inside the visible area: a popover wider than the window keeps its
  // left edge at the margin instead of going negative.
  const leftmost = viewport.left + POPOVER_MARGIN;
  const rightmost = Math.max(
    leftmost,
    viewport.left + viewport.width - POPOVER_MARGIN - width,
  );

  return {
    side,
    fills: false,
    left: Math.min(Math.max(anchor.left, leftmost), rightmost),
    width,
    height: Math.min(POPOVER_PREFERRED_HEIGHT, room[side]),
    top: side === "below" ? anchorBottom + POPOVER_GAP : null,
    bottom: side === "above" ? layoutHeight - (anchorTop - POPOVER_GAP) : null,
  };
}

/**
 * Whether the picker shows its three panes side by side. Below either size the
 * panes become screens instead: stacking all three in one column leaves the
 * provider strip and the model list too short to read (a phone used to get a
 * 23px strip under a 500px list).
 */
export function fitsPanes(fit: PopoverFit): boolean {
  return fit.width >= PANES_MIN_WIDTH && fit.height >= PANES_MIN_HEIGHT;
}

/** The visible area, or the whole window where the visual viewport API is
 * missing (older embedded webviews). */
export function visibleArea(): PopoverViewport {
  const viewport = globalThis.visualViewport;
  return viewport
    ? {
      left: viewport.offsetLeft,
      top: viewport.offsetTop,
      width: viewport.width,
      height: viewport.height,
    }
    : {
      left: 0,
      top: 0,
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    };
}

/** Height of the app's own chrome (the title bar), read from the token so the
 * panel never covers the tabs it explains: a popover that grew over the window
 * frame read as a layout bug, not as an overlay. Cached — the token is a
 * constant of the design, not something that changes with the window. */
let chromeHeight: number | null = null;
function appChromeHeight(): number {
  if (chromeHeight === null) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
      "--tab-height",
    );
    chromeHeight = Number.parseFloat(raw) || 0;
  }
  return chromeHeight;
}

/** The custom properties the popover is drawn with (styles/model-picker.css
 * reads them). They are variables rather than final lengths so the narrow
 * layout can still own its placement: a phone turns the same element into a
 * sheet pinned to the visible bottom and sides, and the sheet covers its own
 * trigger, which an anchor-relative position cannot express. */
export type PopoverStyle = Record<string, string>;

const round = (value: number) => `${Math.round(value)}px`;

/** One measurement: the placement, and whether the three panes fit. */
export interface PopoverPlacement {
  style: PopoverStyle;
  panes: boolean;
  /** The most height the panel may take, in pixels. The picker drops its
   * optional parts (the thinking rail) when even that is tiny. */
  height: number;
}

/**
 * Measure the room around `anchor`. Split out from the hook so the numbers
 * can be reasoned about (and tested) without a DOM.
 */
export function measurePlacement(
  anchor: PopoverAnchor,
  viewport: PopoverViewport,
  layoutHeight: number,
  layoutWidth: number,
  prefer: PopoverSide,
  chrome = 0,
): PopoverPlacement {
  // The window's own bar stays clear: a popover that overlaps the tabs reads
  // as a broken layout rather than as an overlay on the chat.
  const below = {
    left: viewport.left,
    top: viewport.top + chrome,
    width: viewport.width,
    height: Math.max(0, viewport.height - chrome),
  };
  const fit = fitPopover({ anchor, viewport: below, layoutHeight, prefer });
  // The sheet's usable band: the room between the margins inside `below` (the
  // window's bar and the software keyboard are already out of it).
  const sheetRoom = Math.max(0, below.height - 2 * POPOVER_MARGIN);
  // A window too short for either side gets the whole visible area, so the
  // three-pane layout is not forced there: the stepped one owns the small
  // panel (its header is the only way back out of a covered screen).
  const panes = fitsPanes(fit) && !fit.fills;
  return {
    panes,
    height: fit.height,
    style: {
      "--mp-left": round(fit.left),
      "--mp-top": fit.top === null ? "auto" : round(fit.top),
      "--mp-bottom": fit.bottom === null ? "auto" : round(fit.bottom),
      "--mp-width": round(fit.width),
      "--mp-space": round(fit.height),
      // The sheet's edges. They count from the layout viewport's edges, so the
      // part of the page the keyboard covers is added back (0 without a
      // keyboard), and a pinch-zoom pan is followed.
      "--mp-view-left": round(viewport.left + POPOVER_MARGIN),
      "--mp-view-right": round(
        Math.max(0, layoutWidth - viewport.left - viewport.width) +
          POPOVER_MARGIN,
      ),
      "--mp-view-bottom": round(
        Math.max(0, layoutHeight - (viewport.top + viewport.height)) +
          POPOVER_MARGIN,
      ),
      "--mp-sheet-space": round(Math.min(SHEET_MAX_HEIGHT, sheetRoom)),
    },
  };
}

function placementOf(
  trigger: HTMLElement,
  prefer: PopoverSide,
): PopoverPlacement {
  const rect = trigger.getBoundingClientRect();
  return measurePlacement(
    { top: rect.top, bottom: rect.bottom, left: rect.left },
    visibleArea(),
    document.documentElement.clientHeight,
    document.documentElement.clientWidth,
    prefer,
    appChromeHeight(),
  );
}

function samePlacement(
  a: PopoverPlacement | null,
  b: PopoverPlacement | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.panes !== b.panes || a.height !== b.height) return false;
  const keys = Object.keys(a.style);
  return keys.length === Object.keys(b.style).length &&
    keys.every((key) => a.style[key] === b.style[key]);
}

/**
 * Track the room around `anchor` while `open`.
 *
 * It is re-measured on window and visual-viewport resizes (the software
 * keyboard) and on any scroll — the draft screen's composer sits in a
 * scrolling column, so the trigger moves under the popover. Returns `null`
 * until the first measurement: the caller then draws nothing, so a popover
 * never flashes at the stylesheet's fallback position. The measurement runs in
 * a layout effect, i.e. before the browser paints, so the frame that appears
 * is already the placed one.
 *
 * `anchor` is the trigger the popover is placed against. It is passed as a
 * ref object: the composers keep theirs for the click-outside check too, and
 * the settings panel keeps the button in state.
 */
export function usePopoverPlacement(
  anchor: { readonly current: HTMLElement | null },
  open: boolean,
  prefer: PopoverSide = "above",
): PopoverPlacement | null {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);

  useLayoutEffect(() => {
    // A closed popover measures nothing; the next opening measures again (the
    // window may have changed in between).
    if (!open) {
      setPlacement(null);
      return;
    }
    const update = () => {
      const trigger = anchor.current;
      if (trigger === null) return;
      const next = placementOf(trigger, prefer);
      setPlacement((previous) =>
        samePlacement(previous, next) ? previous : next
      );
    };
    update();

    // Scrolls arrive in bursts; one measurement per frame is plenty.
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
  }, [anchor, open, prefer]);

  return placement;
}
