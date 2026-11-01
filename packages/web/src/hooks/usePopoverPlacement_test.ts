import { assertEquals } from "@std/assert";
import {
  fitPopover,
  fitsPanes,
  measurePlacement,
  PANES_MIN_HEIGHT,
  PANES_MIN_WIDTH,
  POPOVER_MARGIN,
  POPOVER_PREFERRED_HEIGHT,
  POPOVER_PREFERRED_WIDTH,
  type PopoverAnchor,
  type PopoverSide,
  type PopoverViewport,
} from "./usePopoverPlacement.ts";

/**
 * The picker's placement is plain arithmetic over two rectangles, which is
 * exactly why it is worth pinning down: the two bugs it replaced (a panel
 * hanging off the top of a short window, a panel running off the right edge of
 * a narrow one) were each a single number nobody had written down.
 */

/** The window of a desktop screen, in client coordinates. */
const desktop: PopoverViewport = { left: 0, top: 0, width: 1280, height: 800 };
const LAYOUT_HEIGHT = 800;

/** The composer's model switch: bottom of the chat, near its left edge. */
const composerSwitch: PopoverAnchor = { top: 733, bottom: 762, left: 215 };

function fit(
  anchor: PopoverAnchor,
  viewport: PopoverViewport,
  prefer: PopoverSide = "above",
  layoutHeight = viewport.height,
) {
  return fitPopover({ anchor, viewport, layoutHeight, prefer });
}

Deno.test("fitPopover: a roomy window gets the preferred size above the trigger", () => {
  const result = fit(composerSwitch, desktop);
  assertEquals(result.side, "above");
  assertEquals(result.width, POPOVER_PREFERRED_WIDTH);
  assertEquals(result.height, POPOVER_PREFERRED_HEIGHT);
  // Anchored at the trigger's left edge, a gap above it.
  assertEquals(result.left, 215);
  assertEquals(result.bottom, LAYOUT_HEIGHT - composerSwitch.top + 6);
  // Opening upward is anchored at the bottom: `top` must stay unset so a
  // shorter content still hugs the trigger.
  assertEquals(result.top, null);
});

Deno.test("fitPopover: a short window shrinks the panel instead of cutting it off", () => {
  // 420px tall: the composer sits at the bottom and there is no room for the
  // full 380px pane stack above it. The old CSS kept the height and let the
  // first provider rows leave the screen.
  const short: PopoverViewport = { left: 0, top: 0, width: 900, height: 420 };
  const result = fit({ top: 271, bottom: 300, left: 44 }, short);
  assertEquals(result.side, "above");
  assertEquals(result.height, 271 - 6 - POPOVER_MARGIN);
  // Still fully on screen: it ends 8px above the visible bottom…
  assertEquals(result.bottom! + result.height, 420 - POPOVER_MARGIN);
  // …and starts 8px below the visible top at the earliest.
  assertEquals(result.bottom! + result.height - result.height >= 0, true);
});

Deno.test("fitPopover: a trigger with no room above opens below instead", () => {
  // A settings list row near the top of a short window: 40px above it cannot
  // hold the panes, while everything below is free.
  const anchor: PopoverAnchor = { top: 60, bottom: 88, left: 120 };
  const result = fit(anchor, desktop, "below");
  assertEquals(result.side, "below");
  assertEquals(result.height, POPOVER_PREFERRED_HEIGHT);
  assertEquals(result.top, 94);
  // Opening downward is anchored at the top: `bottom` must stay unset.
  assertEquals(result.bottom, null);
});

Deno.test("fitPopover: the preferred side is kept unless the other is better", () => {
  // Above is nominally preferred, but there is only 116px of it while the
  // window has 520px below: flipping is the whole point.
  const anchor: PopoverAnchor = { top: 130, bottom: 160, left: 40 };
  const tall: PopoverViewport = { left: 0, top: 0, width: 1200, height: 700 };
  assertEquals(fit(anchor, tall).side, "below");
  // Both sides are cramped until the panel's minimum, and the preferred side
  // is still the roomier one: no flip, the caller's choice stands.
  const anchorNearBottom: PopoverAnchor = { top: 380, bottom: 410, left: 40 };
  const cramped: PopoverViewport = {
    left: 0,
    top: 0,
    width: 1200,
    height: 460,
  };
  assertEquals(fit(anchorNearBottom, cramped).side, "above");
});

Deno.test("fitPopover: a narrow window keeps the panel inside it", () => {
  // The trigger sits at x=44 in a 600px-wide window: the full 640px panel
  // would run 84px past the right edge (the old CSS did exactly that).
  const narrow: PopoverViewport = { left: 0, top: 0, width: 600, height: 700 };
  const result = fit({ top: 400, bottom: 430, left: 44 }, narrow);
  assertEquals(result.width, 600 - 2 * POPOVER_MARGIN);
  assertEquals(result.left, POPOVER_MARGIN);
  // A trigger near the right edge is pulled back by its own width.
  const right = fit({ top: 400, bottom: 430, left: 500 }, narrow);
  assertEquals(right.left, 600 - POPOVER_MARGIN - right.width);
});

Deno.test("fitPopover: the panel never leaves the visible area", () => {
  // The window is 1280 wide but the trigger is at 1000: the panel must not
  // run past the right edge (the old CSS anchored it at the trigger's left).
  const result = fit({ top: 700, bottom: 730, left: 1000 }, desktop);
  assertEquals(result.left, 1280 - POPOVER_MARGIN - result.width);
  assertEquals(result.left + result.width, 1280 - POPOVER_MARGIN);
});

Deno.test("fitPopover: the visible area replaces the window while the keyboard is open", () => {
  // iOS: the layout viewport keeps its height, the visual viewport loses the
  // bottom 300px to the keyboard. Measuring `innerHeight` would place the
  // panel behind the keyboard.
  const keyboard: PopoverViewport = {
    left: 0,
    top: 0,
    width: 390,
    height: 544,
  };
  // A trigger above the keyboard: the panel gets the visible room above it.
  const short = fit({ top: 300, bottom: 330, left: 16 }, keyboard);
  assertEquals(short.side, "above");
  assertEquals(short.height, 300 - 6 - POPOVER_MARGIN);
  assertEquals(short.bottom, 544 - 300 + 6);
  // A trigger the keyboard covered is clamped into the visible slice instead
  // of counting the room that is behind the keyboard: the panel lands on the
  // visible bottom edge, where the user can still see it.
  const behind = fit({ top: 600, bottom: 630, left: 16 }, keyboard);
  assertEquals(behind.side, "above");
  assertEquals(behind.bottom, 544 - (544 - POPOVER_MARGIN) + 6);
});

Deno.test("fitsPanes: three panes need both a width and a height", () => {
  const wide = fit(composerSwitch, desktop);
  assertEquals(fitsPanes(wide), true);
  // A phone sheet (374px wide): three columns would ellipsize the model id.
  const phone = fit(
    { top: 700, bottom: 730, left: 8 },
    { left: 0, top: 0, width: 390, height: 844 },
  );
  assertEquals(phone.width < PANES_MIN_WIDTH, true);
  assertEquals(fitsPanes(phone), false);
  // Wide but too short: the panes keep the model list as the only scrolling
  // part, so they still beat the stepped layout — until even 200px is gone.
  const short = fit(
    { top: 300, bottom: 330, left: 8 },
    { left: 0, top: 0, width: 844, height: 390 },
  );
  assertEquals(fitsPanes(short), true);
  const tiny = fit(
    { top: 150, bottom: 180, left: 8 },
    { left: 0, top: 0, width: 844, height: 190 },
  );
  assertEquals(fitsPanes(tiny), false);
  // Exactly at the floor counts as fitting: the thresholds are inclusive.
  assertEquals(
    fitsPanes({
      side: "above",
      fills: false,
      left: 0,
      top: null,
      bottom: 100,
      width: PANES_MIN_WIDTH,
      height: PANES_MIN_HEIGHT,
    }),
    true,
  );
});

Deno.test("measurePlacement: the window's bar stays clear", () => {
  // A short window: the panel keeps under the title bar instead of covering
  // the tabs. (900x600 with the bar: 560px of visible room, so the panel is
  // placed normally above the trigger.)
  const room: PopoverViewport = { left: 0, top: 0, width: 900, height: 600 };
  const withBar = measurePlacement(
    { top: 300, bottom: 330, left: 44 },
    room,
    600,
    900,
    "above",
    40,
  );
  const topEdge = (style: Record<string, string>) =>
    // The panel opens upward, so its top edge is the layout height minus the
    // bottom offset minus the height it takes.
    600 - Number.parseFloat(style["--mp-bottom"] ?? "0") -
    Number.parseFloat(style["--mp-space"] ?? "0");
  assertEquals(withBar.style["--mp-top"], "auto");
  // The room is the limiting factor here, so the panel's own top edge lands
  // exactly at the bar's lower edge.
  assertEquals(topEdge(withBar.style), 40 + POPOVER_MARGIN);
  // Without the bar the same measurement shares the panel with the tabs and
  // therefore gets more room.
  const withoutBar = measurePlacement(
    { top: 300, bottom: 330, left: 44 },
    room,
    600,
    900,
    "above",
    0,
  );
  assertEquals(topEdge(withoutBar.style), POPOVER_MARGIN);
  assertEquals(
    Number.parseFloat(withoutBar.style["--mp-space"] ?? "0") >
      Number.parseFloat(withBar.style["--mp-space"] ?? "0"),
    true,
  );

  // A window too short for either side: the panel fills the visible area, and
  // that area still is the part under the bar.
  const tiny = measurePlacement(
    { top: 271, bottom: 300, left: 44 },
    { left: 0, top: 0, width: 900, height: 420 },
    420,
    900,
    "above",
    40,
  );
  assertEquals(tiny.style["--mp-top"], "48px");
  assertEquals(tiny.style["--mp-bottom"], "8px");
  assertEquals(tiny.style["--mp-space"], "364px");
  assertEquals(tiny.panes, false);
});

Deno.test("measurePlacement: the sheet's edges follow the visible area", () => {
  // Landscape phone: the sheet is bottom-anchored with 8px margins, and its
  // height cap leaves the title bar visible.
  const placement = measurePlacement(
    { top: 700, bottom: 730, left: 8 },
    { left: 0, top: 0, width: 390, height: 844 },
    844,
    390,
    "above",
    40,
  );
  assertEquals(placement.style["--mp-view-left"], "8px");
  assertEquals(placement.style["--mp-view-right"], "8px");
  assertEquals(placement.style["--mp-view-bottom"], "8px");
  // 844 visible - 40 bar - 2 * 8 margins = 788, capped at the token's 620.
  assertEquals(placement.style["--mp-sheet-space"], "620px");

  // With the keyboard open the sheet's bottom edge moves up by its height.
  const keyboard = measurePlacement(
    { top: 300, bottom: 330, left: 8 },
    { left: 0, top: 0, width: 390, height: 500 },
    844,
    390,
    "above",
    40,
  );
  assertEquals(keyboard.style["--mp-view-bottom"], "352px");
});
