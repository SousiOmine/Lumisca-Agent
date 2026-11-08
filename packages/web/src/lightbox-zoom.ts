/**
 * The geometry of the enlarged picture's zoom (see components/Lightbox.tsx).
 *
 * Pure and apart from the component, so the rules that decide where the
 * picture lands can be checked without a browser: the scale stays inside its
 * limits, the content under the pointer stays under it, and the picture never
 * leaves a gap at the overlay's edge.
 *
 * Coordinates: `ZoomState.x` / `y` are the picture's offset from its centred
 * place, and every point handed to these functions is measured from the
 * overlay's centre — the point the picture grows and shrinks around.
 */

/** A box in CSS pixels: the picture's own layout box, or the overlay's
 * padding box. */
export interface Box {
  width: number;
  height: number;
}

/** A point, in client coordinates at the call site (a pointer, the midpoint of
 * two) and relative to the overlay's centre inside the maths. */
export interface Point {
  x: number;
  y: number;
}

export interface ZoomState {
  /** 1 draws the picture as it fits the window: the state it opens in. */
  scale: number;
  /** Offset from the centred place, in CSS pixels. */
  x: number;
  y: number;
}

/** The state a picture opens and returns to. */
export const ZOOM_FIT = 1;

/**
 * Enlarging stops at 4x. Pictures a session shows are capped at 1568px on the
 * long side (`core/media/stored-image.ts`) and drawn no wider than the window,
 * so the last steps past 4x add interpolation rather than detail — and a wheel
 * that can still keep going makes the gesture feel like it is not working.
 */
export const ZOOM_MAX = 4;

/** What a pinch started from: the state, the finger distance and the midpoint
 * (relative to the overlay's centre) when the second finger landed. */
export interface PinchStart {
  zoom: ZoomState;
  distance: number;
  midpoint: Point;
}

/** Pixels one wheel delta unit covers, indexed by `WheelEvent.deltaMode`
 * (0 pixel, 1 line, 2 page). A line is about 16px and a page about 200px,
 * which is what the three modes are for. */
const DELTA_PIXELS = [1, 16, 200];

/**
 * How much one wheel pixel changes the scale, as `exp`: a notch is the same
 * *proportion* at 1x and at 4x, so the last step into the limit feels like the
 * first. 0.0015 per pixel makes an ordinary 100px notch about 14%.
 */
const WHEEL_RATE = 0.0015;

/** Keep a scale inside the range the picture is ever drawn at. */
export function clampScale(scale: number): number {
  if (Number.isNaN(scale)) return ZOOM_FIT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_FIT, scale));
}

/**
 * Pull the picture back inside the overlay: a scaled picture may be moved
 * until its edge meets the overlay's edge, and no further — beyond that there
 * would be a gap where the backdrop shows through, which reads as the picture
 * having fallen out of the viewer.
 *
 * A picture smaller than the overlay in an axis cannot be moved in it at all,
 * which is also what pins it to the centre at fit.
 */
export function clampOffset(
  state: ZoomState,
  image: Box,
  viewport: Box,
): ZoomState {
  const maxX = Math.max(0, (image.width * state.scale - viewport.width) / 2);
  const maxY = Math.max(0, (image.height * state.scale - viewport.height) / 2);
  return {
    ...state,
    x: Math.min(maxX, Math.max(-maxX, state.x)),
    y: Math.min(maxY, Math.max(-maxY, state.y)),
  };
}

/**
 * Zoom to `nextScale` while keeping the content under `point` under it: the
 * picture grows around the pointer rather than around the window, so what the
 * reader is looking at stays where they are looking.
 */
export function zoomAround(
  state: ZoomState,
  point: Point,
  nextScale: number,
  image: Box,
  viewport: Box,
): ZoomState {
  const scale = clampScale(nextScale);
  const ratio = scale / state.scale;
  return clampOffset(
    {
      scale,
      x: point.x - (point.x - state.x) * ratio,
      y: point.y - (point.y - state.y) * ratio,
    },
    image,
    viewport,
  );
}

/** One wheel event's worth of scale. */
export function wheelScale(
  scale: number,
  deltaY: number,
  deltaMode: number,
): number {
  const unit = DELTA_PIXELS[deltaMode] ?? 1;
  return clampScale(scale * Math.exp(-deltaY * unit * WHEEL_RATE));
}

/**
 * A two-finger gesture: the ratio of the finger distance is the scale, and the
 * midpoint travels with the fingers, so a pinch that also moves the hand pans
 * as it zooms instead of fighting the reader.
 */
export function pinchZoom(
  start: PinchStart,
  current: { distance: number; midpoint: Point },
  image: Box,
  viewport: Box,
): ZoomState {
  if (start.distance <= 0 || start.zoom.scale <= 0) return start.zoom;
  const scale = clampScale(
    start.zoom.scale * (current.distance / start.distance),
  );
  const ratio = scale / start.zoom.scale;
  return clampOffset(
    {
      scale,
      x: current.midpoint.x - (start.midpoint.x - start.zoom.x) * ratio,
      y: current.midpoint.y - (start.midpoint.y - start.zoom.y) * ratio,
    },
    image,
    viewport,
  );
}

/** The CSS transform that draws `state`: translation first (the offset is in
 * the overlay's own pixels), then the scale around the picture's centre. */
export function transformOf(state: ZoomState): string {
  return `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.scale})`;
}

/** The distance between two pointers, in client coordinates. */
export function distanceOf(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Where two pointers meet, in client coordinates. */
export function midpointOf(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
