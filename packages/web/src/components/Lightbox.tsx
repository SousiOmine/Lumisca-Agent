/**
 * The enlarged view of a picture: click a thumbnail, see the whole thing.
 *
 * A conversation draws pictures at a few hundred pixels because a message is
 * not a photo viewer — but a screenshot's text is unreadable at that size, and
 * the reason to show it is to be read. The click opens the original (never the
 * downscaled preview the list drew, see media/preview.ts), fills the window,
 * and closes on Escape or on the backdrop.
 *
 * It also zooms: the wheel (and a trackpad pinch, which arrives as a wheel),
 * two fingers on a touch screen, and a click on the picture — each around the
 * point it happened at, so what the reader is looking at stays where they are
 * looking. A drag pans while the picture is enlarged.
 *
 * Drawn as one element over the app rather than a route: looking at a picture
 * is not a place you navigate to, and leaving the conversation to see one
 * would lose the scroll position on the way back.
 *
 * The overlay and the picture fade in and out with a slight scale, and the
 * overlay outlives `src` going null so the exit is played rather than
 * teleported (hooks/usePresence). The travel is `play()` (motion.ts), which
 * cancels itself for a reader who asked for less motion; the fades stay.
 */
import { useCallback, useEffect, useRef } from "preact/compat";
import { useReducedMotion } from "../hooks/useMediaQuery.ts";
import { useModalKeyboard } from "../hooks/useModalKeyboard.ts";
import { usePresence } from "../hooks/usePresence.ts";
import { useT } from "../i18n.ts";
import {
  type Box,
  clampOffset,
  distanceOf,
  midpointOf,
  type PinchStart,
  type Point,
  pinchZoom,
  transformOf,
  wheelScale,
  ZOOM_FIT,
  type ZoomState,
  zoomAround,
} from "../lightbox-zoom.ts";
import { EASE_OUT, EXIT_SECONDS, play } from "../motion.ts";

export interface LightboxProps {
  /** The picture to show, already a URL the browser can load. `null` closes
   * it: the overlay stays mounted while it shrinks, so the caller only has to
   * say whether it is open (see hooks/usePresence). */
  src: string | null;
  /** What the picture is called (the attachment's name), for the label. */
  alt?: string;
  onClose: () => void;
}

/** How far a pointer may travel before the press counts as a drag rather than
 * a click. A few pixels, because a finger is not still while it taps. */
const DRAG_SLOP = 3;

/** Where a click on the picture lands it: close enough to read text a
 * thumbnail could not show, without a second click to get back. */
const CLICK_SCALE = 2;

/** Longer than the smooth-zoom transition (`--lum-dur-fast`, 120ms): the
 * attribute must outlive it, or the transition is cut before its last frame. */
const SMOOTH_MS = 160;

/** A pan in progress: where the pointer went down, and where the picture was
 * then. The offset is the difference between the two, not an accumulation of
 * move deltas, so a dropped event cannot make the picture drift. */
interface Drag {
  pointerId: number;
  from: Point;
  origin: Point;
  moved: boolean;
}

/** The pointers currently down, and what they are doing. */
interface Gesture {
  pointers: Map<number, Point>;
  drag: Drag | null;
  pinch: PinchStart | null;
  /** The `click` that follows this gesture belongs to it, not to the reader: a
   * drag that ended where it started, or a pinch, must not be read as "close"
   * or as "zoom". Cleared when that click arrives, and when a new gesture
   * starts, so a cancelled gesture cannot swallow the next tap. */
  suppressClick: boolean;
}

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const reduceMotion = useReducedMotion();
  const presence = usePresence(src !== null, { instant: reduceMotion });
  // Closing clears `src`, but the picture is still on screen while it shrinks
  // back: the overlay keeps drawing the one it was opened with.
  const last = useRef<{ src: string; alt?: string } | null>(null);
  if (src !== null) last.current = { src, alt };
  const shown = last.current;
  if (!presence.mounted || shown === null) return null;
  return (
    <LightboxSurface
      src={shown.src}
      alt={shown.alt}
      exiting={presence.exiting}
      onExitDone={presence.done}
      onClose={onClose}
    />
  );
}

function LightboxSurface({
  src,
  alt,
  exiting,
  onClose,
  onExitDone,
}: {
  src: string;
  alt?: string;
  /** On its way out: play the exit, then call `onExitDone` (see usePresence). */
  exiting: boolean;
  onClose: () => void;
  onExitDone: () => void;
}) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const overlayRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // Escape, Tab, the focus and the scroll lock behind the overlay: the same
  // four things a dialog owes (see the hook).
  useModalKeyboard({ surface: overlayRef, onClose });

  // Where the picture is drawn, in a ref: a wheel or a pointermove writes the
  // transform straight onto the element, and re-rendering per frame would
  // rebuild the conversation this overlay is covering.
  const zoom = useRef<ZoomState>({ scale: ZOOM_FIT, x: 0, y: 0 });
  const gesture = useRef<Gesture>({
    pointers: new Map(),
    drag: null,
    pinch: null,
    suppressClick: false,
  });
  const smoothTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // The listeners below are bound once; `exiting` is read through a ref so a
  // gesture that lands between the close and the unmount does nothing.
  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;

  const applyZoom = useCallback((next: ZoomState) => {
    zoom.current = next;
    const image = imageRef.current;
    if (image === null) return;
    image.style.transform = transformOf(next);
    image.dataset.zoom = next.scale > ZOOM_FIT ? "in" : "fit";
  }, []);

  /** Let the next step of the zoom travel instead of jumping. The transition is
   * on only while it is wanted: a pan that eased would trail the finger. */
  const smoothZoom = useCallback(() => {
    const image = imageRef.current;
    if (image === null) return;
    clearTimeout(smoothTimer.current);
    image.dataset.zoomSmooth = "true";
    smoothTimer.current = setTimeout(() => {
      if (image.isConnected) delete image.dataset.zoomSmooth;
    }, SMOOTH_MS);
  }, []);

  const unsmoothZoom = useCallback(() => {
    clearTimeout(smoothTimer.current);
    const image = imageRef.current;
    if (image !== null) delete image.dataset.zoomSmooth;
  }, []);

  /** The two boxes a gesture is clamped against, measured from the elements:
   * the picture's layout box (a transform is not part of it) and the overlay's
   * padding box, which is what the reader can see. */
  const frame = useCallback((): { image: Box; viewport: Box } | null => {
    const image = imageRef.current;
    const overlay = overlayRef.current;
    if (image === null || overlay === null) return null;
    const box = { width: image.offsetWidth, height: image.offsetHeight };
    if (box.width === 0 || box.height === 0) return null;
    return {
      image: box,
      viewport: { width: overlay.clientWidth, height: overlay.clientHeight },
    };
  }, []);

  /** The overlay's centre in client coordinates: the origin a gesture's point
   * is taken from, because the picture is centred there and `scale` grows it
   * around its own centre. */
  const centre = useCallback((): Point | null => {
    const overlay = overlayRef.current;
    if (overlay === null) return null;
    const rect = overlay.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, []);

  /** Zoom so that the content under `point` (client coordinates) stays under
   * it. Nothing happens until the picture has a box to measure: until its bytes
   * arrive there is nothing to anchor the zoom to. */
  const zoomAt = useCallback(
    (point: Point, nextScale: number) => {
      const origin = centre();
      const boxes = frame();
      if (origin === null || boxes === null) return;
      applyZoom(
        zoomAround(
          zoom.current,
          { x: point.x - origin.x, y: point.y - origin.y },
          nextScale,
          boxes.image,
          boxes.viewport,
        ),
      );
    },
    [applyZoom, centre, frame],
  );

  useEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;

    const onWheel = (event: WheelEvent) => {
      if (exitingRef.current) return;
      // The wheel belongs to the picture while it is open: without this the
      // conversation behind scrolls as the picture grows.
      event.preventDefault();
      unsmoothZoom();
      zoomAt(
        { x: event.clientX, y: event.clientY },
        wheelScale(zoom.current.scale, event.deltaY, event.deltaMode),
      );
    };

    const onPointerDown = (event: PointerEvent) => {
      if (exitingRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const state = gesture.current;
      if (state.pointers.size === 0) state.suppressClick = false;
      state.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      unsmoothZoom();
      if (state.pointers.size >= 2) {
        // The second finger turns a press into a gesture: nothing is being
        // dragged any more, and the click that ends it is not a tap.
        state.drag = null;
        state.suppressClick = true;
        if (state.pointers.size > 2) return;
        const origin = centre();
        const pair = firstTwo(state.pointers);
        if (origin === null || pair === null) return;
        const midpoint = midpointOf(pair[0], pair[1]);
        state.pinch = {
          zoom: zoom.current,
          distance: distanceOf(pair[0], pair[1]),
          midpoint: { x: midpoint.x - origin.x, y: midpoint.y - origin.y },
        };
        return;
      }
      state.pinch = null;
      // Only a press that lands on the picture can pan it; a press on the
      // backdrop is the click that closes.
      state.drag =
        event.target instanceof HTMLImageElement
          ? {
              pointerId: event.pointerId,
              from: { x: event.clientX, y: event.clientY },
              origin: { x: zoom.current.x, y: zoom.current.y },
              moved: false,
            }
          : null;
    };

    const onPointerMove = (event: PointerEvent) => {
      const state = gesture.current;
      if (!state.pointers.has(event.pointerId)) return;
      state.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      const boxes = frame();
      const origin = centre();
      if (boxes === null || origin === null) return;

      if (state.pinch !== null && state.pointers.size >= 2) {
        const pair = firstTwo(state.pointers);
        if (pair === null) return;
        const midpoint = midpointOf(pair[0], pair[1]);
        applyZoom(
          pinchZoom(
            state.pinch,
            {
              distance: distanceOf(pair[0], pair[1]),
              midpoint: { x: midpoint.x - origin.x, y: midpoint.y - origin.y },
            },
            boxes.image,
            boxes.viewport,
          ),
        );
        return;
      }

      const drag = state.drag;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.from.x;
      const dy = event.clientY - drag.from.y;
      if (!drag.moved) {
        if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
        drag.moved = true;
        state.suppressClick = true;
        const image = imageRef.current;
        if (image !== null) image.dataset.drag = "true";
      }
      // A picture that fits has nowhere to go: it is pinned to the centre.
      if (zoom.current.scale <= ZOOM_FIT) return;
      applyZoom(
        clampOffset(
          {
            scale: zoom.current.scale,
            x: drag.origin.x + dx,
            y: drag.origin.y + dy,
          },
          boxes.image,
          boxes.viewport,
        ),
      );
    };

    const onPointerUp = (event: PointerEvent) => {
      const state = gesture.current;
      if (!state.pointers.delete(event.pointerId)) return;
      const image = imageRef.current;
      if (image !== null) delete image.dataset.drag;
      if (state.drag !== null && state.drag.pointerId === event.pointerId) {
        state.drag = null;
      }
      if (state.pointers.size < 2) state.pinch = null;
    };

    const onResize = () => {
      // The limits were measured against a window that no longer exists: the
      // picture goes back inside the one that does.
      const boxes = frame();
      if (boxes === null) return;
      applyZoom(clampOffset(zoom.current, boxes.image, boxes.viewport));
    };

    // Non-passive: the wheel zooms, so it must not also scroll the page behind
    // (a listener on an element defaults to non-passive, but the option says
    // so rather than relying on it).
    overlay.addEventListener("wheel", onWheel, { passive: false });
    overlay.addEventListener("pointerdown", onPointerDown);
    // On the window rather than the overlay: a drag toward an edge has to end
    // even when the pointer leaves the element, and a finger lifted outside it
    // is not a stuck gesture.
    globalThis.addEventListener("pointermove", onPointerMove);
    globalThis.addEventListener("pointerup", onPointerUp);
    globalThis.addEventListener("pointercancel", onPointerUp);
    globalThis.addEventListener("resize", onResize);
    return () => {
      overlay.removeEventListener("wheel", onWheel);
      overlay.removeEventListener("pointerdown", onPointerDown);
      globalThis.removeEventListener("pointermove", onPointerMove);
      globalThis.removeEventListener("pointerup", onPointerUp);
      globalThis.removeEventListener("pointercancel", onPointerUp);
      globalThis.removeEventListener("resize", onResize);
    };
  }, [applyZoom, centre, frame, unsmoothZoom, zoomAt]);

  useEffect(() => () => clearTimeout(smoothTimer.current), []);

  // Leave. The overlay is still mounted (the caller keeps it up through
  // usePresence), so the exit plays rather than teleports.
  useEffect(() => {
    if (!exiting) return;
    const overlay = overlayRef.current;
    const image = imageRef.current;
    // Where the picture stands now: a reader who zoomed in sees it shrink from
    // there instead of jumping back to fit for one frame.
    const from =
      image === null ? "scale(1)" : getComputedStyle(image).transform;
    if (overlay !== null) overlay.dataset.exiting = "true";
    const options = {
      duration: EXIT_SECONDS,
      easing: EASE_OUT,
      prefersReducedMotion: reduceMotion,
    };
    let cancelled = false;
    void Promise.all([
      play(overlay, { opacity: [1, 0] }, options),
      image === null
        ? Promise.resolve(null)
        : play(
            image,
            {
              opacity: [1, 0],
              transform: [from === "none" ? "scale(1)" : from, "scale(0.96)"],
            },
            options,
          ),
    ]).then(async (running) => {
      // Nothing to play (reduced motion, or the library could not be loaded):
      // the overlay goes now rather than waiting for an animation that never
      // starts.
      await Promise.all(
        running.map((item) => item?.finished ?? Promise.resolve()),
      );
      if (!cancelled) onExitDone();
    });
    return () => {
      cancelled = true;
    };
  }, [exiting, onExitDone, reduceMotion]);

  const onClick = (event: MouseEvent) => {
    if (exiting) return;
    const state = gesture.current;
    if (state.suppressClick) {
      state.suppressClick = false;
      return;
    }
    // The second click of a double click was answered by the first one.
    if (event.detail > 1) return;
    if (!(event.target instanceof HTMLImageElement)) {
      onClose();
      return;
    }
    // A click on the picture is the zoom: closer while it fits, back to the
    // whole picture while it is enlarged. Closing is the backdrop or Escape,
    // never a stray tap on the picture the reader is inspecting.
    if (zoom.current.scale > ZOOM_FIT) {
      smoothZoom();
      applyZoom({ scale: ZOOM_FIT, x: 0, y: 0 });
      return;
    }
    smoothZoom();
    zoomAt({ x: event.clientX, y: event.clientY }, CLICK_SCALE);
  };

  return (
    <div
      ref={overlayRef}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? t("common.imagePreview")}
      tabIndex={-1}
      onClick={onClick}
    >
      <img
        ref={imageRef}
        className="lightbox-image"
        src={src}
        alt={alt ?? ""}
        // A native image drag would take the pan away from the pointer
        // handlers: the browser starts its own drag with the picture.
        draggable={false}
      />
    </div>
  );
}

/** The first two pointers down, in insertion order. */
function firstTwo(pointers: Map<number, Point>): [Point, Point] | null {
  const values = [...pointers.values()];
  const first = values[0];
  const second = values[1];
  return first === undefined || second === undefined ? null : [first, second];
}
