/**
 * The zoom of the enlarged picture, without a browser: what the scale is
 * allowed to be, and where the picture lands when a gesture anchors it to a
 * point. The bug these catch is invisible in a screenshot — a picture that
 * drifts away from the pointer, or that can be pushed until there is a gap
 * where the backdrop shows through.
 */
import { assertEquals } from "@std/assert";
import {
  type Box,
  clampOffset,
  clampScale,
  distanceOf,
  midpointOf,
  pinchZoom,
  transformOf,
  wheelScale,
  ZOOM_FIT,
  ZOOM_MAX,
  zoomAround,
} from "./lightbox-zoom.ts";

/** A picture 800×600 in a 1000×800 overlay: the proportions a screenshot has
 * when the window is the desktop app's. */
const IMAGE: Box = { width: 800, height: 600 };
const VIEWPORT: Box = { width: 1000, height: 800 };

Deno.test("zoom: the scale is held between the fit and the limit", () => {
  assertEquals(clampScale(0.2), ZOOM_FIT);
  assertEquals(clampScale(ZOOM_MAX + 10), ZOOM_MAX);
  assertEquals(clampScale(2.5), 2.5);
  // A gesture can divide by a distance of zero (two fingers on one spot).
  assertEquals(clampScale(Number.NaN), ZOOM_FIT);
  assertEquals(clampScale(Number.POSITIVE_INFINITY), ZOOM_MAX);
});

Deno.test("zoom: a picture that fits cannot be moved", () => {
  // The whole point of the fit state: the picture is centred, so a drag at 1x
  // must not leave it off centre.
  assertEquals(
    clampOffset({ scale: ZOOM_FIT, x: 40, y: -40 }, IMAGE, VIEWPORT),
    { scale: ZOOM_FIT, x: 0, y: 0 },
  );
});

Deno.test("zoom: an enlarged picture stops at the overlay's edge", () => {
  // At 2x the picture is 1600×1200 in a 1000×800 overlay: 300px of it can be
  // shown either side horizontally, 200px vertically.
  assertEquals(clampOffset({ scale: 2, x: 500, y: -500 }, IMAGE, VIEWPORT), {
    scale: 2,
    x: 300,
    y: -200,
  });
  assertEquals(clampOffset({ scale: 2, x: -500, y: 500 }, IMAGE, VIEWPORT), {
    scale: 2,
    x: -300,
    y: 200,
  });
  // Inside the limits the offset is the reader's.
  assertEquals(clampOffset({ scale: 2, x: 120, y: -80 }, IMAGE, VIEWPORT), {
    scale: 2,
    x: 120,
    y: -80,
  });
});

Deno.test("zoom: the point under the pointer stays under it", () => {
  // A click 100px right of the centre at 2x: that same spot of the picture has
  // to be 100px right of the centre afterwards.
  const zoomed = zoomAround(
    { scale: ZOOM_FIT, x: 0, y: 0 },
    { x: 100, y: 0 },
    2,
    IMAGE,
    VIEWPORT,
  );
  assertEquals(zoomed.scale, 2);
  const contentBefore = (100 - 0) / 1;
  const contentAfter = (100 - zoomed.x) / zoomed.scale;
  assertEquals(contentAfter, contentBefore);

  // A click on the centre grows the picture around its own middle: nothing
  // moves.
  assertEquals(
    zoomAround(
      { scale: ZOOM_FIT, x: 0, y: 0 },
      { x: 0, y: 0 },
      2,
      IMAGE,
      VIEWPORT,
    ),
    { scale: 2, x: 0, y: 0 },
  );
});

Deno.test("zoom: an anchor past the edge is pulled back inside", () => {
  // Zooming at a point near the top-left corner would ask for an offset the
  // clamp cannot give; what must survive is the limit, not the anchor.
  const zoomed = zoomAround(
    { scale: ZOOM_FIT, x: 0, y: 0 },
    { x: -450, y: -350 },
    4,
    IMAGE,
    VIEWPORT,
  );
  assertEquals(zoomed.scale, 4);
  const maxX = (IMAGE.width * 4 - VIEWPORT.width) / 2;
  const maxY = (IMAGE.height * 4 - VIEWPORT.height) / 2;
  assertEquals(zoomed.x >= -maxX && zoomed.x <= maxX, true);
  assertEquals(zoomed.y >= -maxY && zoomed.y <= maxY, true);
});

Deno.test("zoom: a pinch scales by the fingers and follows their midpoint", () => {
  const start = {
    zoom: { scale: ZOOM_FIT, x: 0, y: 0 },
    distance: 100,
    midpoint: { x: 0, y: 0 },
  };
  // Twice the distance, same midpoint: 2x around the centre.
  assertEquals(
    pinchZoom(
      start,
      { distance: 200, midpoint: { x: 0, y: 0 } },
      IMAGE,
      VIEWPORT,
    ),
    { scale: 2, x: 0, y: 0 },
  );
  // A pinch that also moves the hand 40px right takes the picture with it.
  assertEquals(
    pinchZoom(
      start,
      { distance: 200, midpoint: { x: 40, y: 0 } },
      IMAGE,
      VIEWPORT,
    ),
    { scale: 2, x: 40, y: 0 },
  );
  // Two fingers on one spot cannot divide the scale.
  assertEquals(
    pinchZoom(
      { ...start, distance: 0 },
      { distance: 10, midpoint: { x: 0, y: 0 } },
      IMAGE,
      VIEWPORT,
    ),
    start.zoom,
  );
  // The limit holds however far the fingers spread.
  assertEquals(
    pinchZoom(
      start,
      { distance: 100_000, midpoint: { x: 0, y: 0 } },
      IMAGE,
      VIEWPORT,
    ).scale,
    ZOOM_MAX,
  );
});

Deno.test("zoom: the wheel is proportional and reads all three delta modes", () => {
  // Scrolling down (away from the reader) leaves the picture, up brings it in.
  assertEquals(wheelScale(2, 100, 0) < 2, true);
  assertEquals(wheelScale(2, -100, 0) > 2, true);
  // One notch is the same proportion at either end of the range.
  const atFit = wheelScale(1, -100, 0) / 1;
  const atThree = wheelScale(3, -100, 0) / 3;
  assertEquals(Math.round(atFit * 1000), Math.round(atThree * 1000));
  // A page and 200 pixels are the same amount of travel, as are 3 lines and
  // the 48 pixels a line is taken to be.
  assertEquals(
    Math.round(wheelScale(2, 1, 2) * 1000),
    Math.round(wheelScale(2, 200, 0) * 1000),
  );
  assertEquals(
    Math.round(wheelScale(2, 3, 1) * 1000),
    Math.round(wheelScale(2, 48, 0) * 1000),
  );
  // At fit, scrolling out has nowhere to go.
  assertEquals(wheelScale(ZOOM_FIT, 400, 0), ZOOM_FIT);
});

Deno.test("zoom: the transform is the offset, then the scale", () => {
  assertEquals(
    transformOf({ scale: 2, x: -12.5, y: 4 }),
    "translate3d(-12.5px, 4px, 0) scale(2)",
  );
});

Deno.test("zoom: a pinch is measured from two pointers", () => {
  const a = { x: 100, y: 100 };
  const b = { x: 400, y: 500 };
  assertEquals(distanceOf(a, b), 500);
  assertEquals(midpointOf(a, b), { x: 250, y: 300 });
});
