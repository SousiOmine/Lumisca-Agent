import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeCapture } from "./image.ts";
import type {
  MonitorLayout,
  PortalClient,
  PortalSession,
  PortalStream,
  ScreenImage,
} from "./portal/types.ts";
import type { MouseButton } from "./types.ts";
import { createWaylandComputerHost, WaylandComputerHost } from "./wayland.ts";

// The fakes below stand in for the desktop: a portal client that serves a
// prepared layout, one prepared screenshot and one prepared session. On a
// machine with a single display this is the only way to exercise the
// multi-monitor arithmetic, which is the part of the Wayland host that
// cannot be checked by hand here.

/**
 * Two monitors with different scales, the left one negative in the
 * compositor's space (that is what a monitor left of the primary one looks
 * like there):
 *
 *   DP-1        640×360 physical, scale 2 → 320×180 logical, at (-320, 0)
 *   Virtual-1   480×270 physical, scale 1 → 480×270 logical, at (0, 0) (primary)
 *
 * The desktop is 800×270 logical, and a screenshot is painted at
 * max(scale) = 2 pixels per logical pixel → 1600×540.
 */
function mixedLayout(): MonitorLayout {
  return {
    monitors: [
      {
        x: -320,
        y: 0,
        width: 320,
        height: 180,
        scale: 2,
        primary: false,
        connectors: ["DP-1"],
      },
      {
        x: 0,
        y: 0,
        width: 480,
        height: 270,
        scale: 1,
        primary: true,
        connectors: ["Virtual-1"],
      },
    ],
    x: -320,
    y: 0,
    width: 800,
    height: 270,
  };
}

/** The streams mutter reports for mixedLayout(): position and size in the
 * compositor's space, plus the connector names `output-name` carries. */
function mixedStreams(): PortalStream[] {
  return [
    {
      id: 11,
      connectors: ["DP-1"],
      position: { x: -320, y: 0 },
      size: { width: 320, height: 180 },
    },
    {
      id: 12,
      connectors: ["Virtual-1"],
      position: { x: 0, y: 0 },
      size: { width: 480, height: 270 },
    },
  ];
}

/** An image whose pixels encode their own position, so a crop can be checked
 * against the absolute pixels it came from. */
function makeImage(width: number, height: number): ScreenImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      writePixel(pixels, (y * width + x) * 4, x, y);
    }
  }
  return { width, height, pixels };
}

function writePixel(out: Uint8Array, at: number, x: number, y: number): void {
  out[at] = (x * 7 + y * 3) & 0xff;
  out[at + 1] = (x + y * 13) & 0xff;
  out[at + 2] = (x ^ y) & 0xff;
  out[at + 3] = 0xff;
}

/** The pixel makeImage() writes for an absolute position. */
function expectedPixel(x: number, y: number): number[] {
  return [
    (x * 7 + y * 3) & 0xff,
    (x + y * 13) & 0xff,
    (x ^ y) & 0xff,
    0xff,
  ];
}

class FakeSession implements PortalSession {
  readonly motions: Array<[number, number, number]> = [];
  readonly buttons: Array<[MouseButton, boolean]> = [];
  readonly scrolls: Array<["vertical" | "horizontal", number]> = [];
  readonly keysyms: Array<[number, boolean]> = [];
  closed = false;
  /** Makes every motion fail, the way a session that ended under the host
   * behaves (the compositor restarted, the user stopped sharing). */
  failMotion = false;

  constructor(
    readonly streams: PortalStream[],
    readonly restoreToken?: string,
  ) {}

  pointerMotionAbsolute(
    streamId: number,
    x: number,
    y: number,
  ): Promise<void> {
    if (this.failMotion) {
      return Promise.reject(new Error("the session ended"));
    }
    this.motions.push([streamId, x, y]);
    return Promise.resolve();
  }

  pointerButton(button: MouseButton, pressed: boolean): Promise<void> {
    this.buttons.push([button, pressed]);
    return Promise.resolve();
  }

  pointerAxisDiscrete(
    axis: "vertical" | "horizontal",
    steps: number,
  ): Promise<void> {
    this.scrolls.push([axis, steps]);
    return Promise.resolve();
  }

  keyboardKeysym(keysym: number, pressed: boolean): Promise<void> {
    this.keysyms.push([keysym, pressed]);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakePortal implements PortalClient {
  layout: MonitorLayout = mixedLayout();
  streams: PortalStream[] = mixedStreams();
  image: ScreenImage = makeImage(1600, 540);
  sessions: FakeSession[] = [];
  captures = 0;
  disconnected = false;
  /** Makes the sessions this portal hands out fail their input calls. */
  failMotion = false;

  monitorLayout(): Promise<MonitorLayout> {
    return Promise.resolve(this.layout);
  }

  captureScreen(): Promise<ScreenImage> {
    this.captures++;
    return Promise.resolve(this.image);
  }

  openSession(): Promise<PortalSession> {
    const session = new FakeSession(this.streams, "token-1");
    session.failMotion = this.failMotion;
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

function makeHost(): { portal: FakePortal; host: WaylandComputerHost } {
  const portal = new FakePortal();
  return { portal, host: new WaylandComputerHost(portal, portal.layout) };
}

// --- geometry ---------------------------------------------------------------

Deno.test("a Wayland host describes itself and reports the desktop bounding box", () => {
  const { host } = makeHost();
  assertEquals(host.capabilities, { windows: false, cursor: false });
  assertEquals(
    host.describe(),
    "GNOME (Wayland), 2 displays: " +
      "320×180 scale 2, 480×270 scale 1 primary",
  );
  // Screen units start at the desktop's own origin, so the monitor that sits
  // at x = -320 in the compositor's space begins at 0 here.
  assertEquals(host.displays(), [
    {
      index: 0,
      primary: false,
      bounds: { x: 0, y: 0, width: 320, height: 180 },
    },
    {
      index: 1,
      primary: true,
      bounds: { x: 320, y: 0, width: 480, height: 270 },
    },
  ]);
  host.close();
});

Deno.test("Wayland reports no pointer and no windows", () => {
  const { host } = makeHost();
  assertEquals(host.cursor(), undefined);
  assertEquals(host.windows(), []);
  host.close();
});

// --- capture ----------------------------------------------------------------

Deno.test("capture crops the whole-desktop image at the compositor's scale", async () => {
  const { host } = makeHost();
  // The primary monitor's region starts at screen x = 320, which is image
  // x = 640 when the screenshot is painted at scale 2.
  const raw = await host.capture({ x: 320, y: 0, width: 480, height: 270 });
  assertEquals(raw.screen, { x: 320, y: 0, width: 480, height: 270 });
  assertEquals([raw.width, raw.height], [960, 540]);
  for (const [localX, localY] of [[0, 0], [7, 3], [959, 539]] as const) {
    const at = (localY * raw.width + localX) * 4;
    assertEquals(
      [...raw.pixels.subarray(at, at + 4)],
      expectedPixel(640 + localX, localY),
      `pixel (${localX}, ${localY}) of the crop`,
    );
  }
  host.close();
});

Deno.test("capture of the smaller-scale monitor keeps that monitor's picture", async () => {
  const { host } = makeHost();
  const raw = await host.capture({ x: 0, y: 0, width: 320, height: 180 });
  assertEquals([raw.width, raw.height], [640, 360]);
  // The left monitor is upscaled into the scale-2 image, so its picture
  // comes from image x 0..640.
  const at = (10 * raw.width + 20) * 4;
  assertEquals([...raw.pixels.subarray(at, at + 4)], expectedPixel(20, 10));
  host.close();
});

Deno.test("the reported image scale maps image pixels back to screen units", async () => {
  const { host } = makeHost();
  const raw = await host.capture({ x: 320, y: 0, width: 480, height: 270 });
  // 960 image pixels cover 480 screen units: dividing by the reported scale
  // must give the screen position the agent aimed at.
  const encoded = encodeCapture(raw, 4096);
  assertEquals(encoded.scale, 2);
  const imagePoint = { x: 200, y: 100 };
  const screen = {
    x: Math.round(imagePoint.x / encoded.scale) + raw.screen.x,
    y: Math.round(imagePoint.y / encoded.scale) + raw.screen.y,
  };
  assertEquals(screen, { x: 420, y: 50 });
  host.close();
});

Deno.test("capture refuses a screenshot that does not match the layout", async () => {
  const { portal, host } = makeHost();
  portal.image = makeImage(100, 100);
  await assertRejects(
    () => host.capture({ x: 0, y: 0, width: 320, height: 180 }),
    Error,
    "does not match",
  );
  host.close();
});

Deno.test("capture refuses a region outside the desktop", async () => {
  const { host } = makeHost();
  await assertRejects(
    () => host.capture({ x: 0, y: 0, width: 900, height: 270 }),
    Error,
    "outside the desktop",
  );
  host.close();
});

// --- input ------------------------------------------------------------------

Deno.test("a click is converted into the target monitor's physical grid", async () => {
  const { portal, host } = makeHost();
  // Screen (100, 50) is on the scale-2 monitor: its stream grid is twice the
  // distance from that monitor's own origin, which is 0 in screen units.
  await host.act({ kind: "click", x: 100, y: 50, button: "left", count: 1 });
  const first = portal.sessions.at(0)!;
  assertEquals(first.motions.at(-1), [11, 200, 100]);
  assertEquals(first.buttons, [["left", true], ["left", false]]);

  // Screen (400, 100) is on the primary monitor (screen x 320..800): one
  // screen unit there is one stream pixel.
  await host.act({ kind: "click", x: 400, y: 100, button: "right", count: 2 });
  assertEquals(first.motions.at(-1), [12, 80, 100]);
  assertEquals(first.buttons.slice(2), [
    ["right", true],
    ["right", false],
    ["right", true],
    ["right", false],
  ]);
  host.close();
});

Deno.test("pointer movement is interpolated and ends exactly on the target", async () => {
  const { portal, host } = makeHost();
  const result = await host.act({ kind: "move", x: 460, y: 200 });
  assert(
    result.steps > 1,
    `expected an interpolated path, got ${result.steps}`,
  );
  const session = portal.sessions.at(0)!;
  assertEquals(session.motions.length, result.steps);
  assertEquals(session.motions.at(-1), [12, 140, 200]);
  assert(result.durationMs >= 0);
  // Wayland cannot report where the pointer is, so the result must not
  // pretend to know.
  assertEquals(result.cursor, undefined);
  host.close();
});

Deno.test("scrolling carries the tool layer's sign convention", async () => {
  const { portal, host } = makeHost();
  await host.act({ kind: "scroll", x: 400, y: 100, deltaX: 3, deltaY: -2 });
  const session = portal.sessions.at(0)!;
  // Positive deltaY is "down" for the caller, and positive steps scroll down
  // for the portal; positive deltaX is "right".
  assertEquals(session.scrolls, [["vertical", -2], ["horizontal", 3]]);
  host.close();
});

Deno.test("typing sends one keysym per character and Enter for a newline", async () => {
  const { portal, host } = makeHost();
  await host.act({ kind: "type", text: "a\nあ" });
  const session = portal.sessions.at(0)!;
  assertEquals(session.keysyms, [
    [0x61, true],
    [0x61, false],
    [0xff0d, true],
    [0xff0d, false],
    [0x01000000 + 0x3042, true],
    [0x01000000 + 0x3042, false],
  ]);
  host.close();
});

Deno.test("a key chord holds its modifiers around the key", async () => {
  const { portal, host } = makeHost();
  await host.act({ kind: "key", key: "ctrl+shift+s" });
  const session = portal.sessions.at(0)!;
  assertEquals(session.keysyms, [
    [0xffe3, true], // Control_L
    [0xffe1, true], // Shift_L
    [0x73, true], // s
    [0x73, false],
    [0xffe1, false],
    [0xffe3, false],
  ]);
  host.close();
});

Deno.test("focus_window is refused with the Wayland reason", async () => {
  const { host } = makeHost();
  await assertRejects(
    () => host.act({ kind: "focus_window", window: "0x00000001" }),
    Error,
    "not possible on Wayland",
  );
  host.close();
});

Deno.test("wait sleeps without touching the session", async () => {
  const { portal, host } = makeHost();
  const result = await host.act({ kind: "wait", durationMs: 5 });
  assertEquals(result.steps, 0);
  assertEquals(portal.sessions.length, 0);
  host.close();
});

// --- the screen-sharing session ---------------------------------------------

Deno.test("the screen-sharing session is opened once, on the first input", async () => {
  const { portal, host } = makeHost();
  await host.act({ kind: "move", x: 400, y: 100 });
  await host.act({ kind: "click", x: 400, y: 100, button: "left", count: 1 });
  assertEquals(portal.sessions.length, 1);
  // Screenshots do not need a session at all (they have their own
  // permission), so the dialog appears for input only.
  await host.capture({ x: 0, y: 0, width: 320, height: 180 });
  assertEquals(portal.sessions.length, 1);
  host.close();
});

Deno.test("a monitor the user did not share is reported and the session dropped", async () => {
  const { portal, host } = makeHost();
  portal.streams = mixedStreams().filter((stream) =>
    stream.connectors.includes("Virtual-1")
  );
  await assertRejects(
    () => host.act({ kind: "click", x: 100, y: 50, button: "left", count: 1 }),
    Error,
    "did not share",
  );
  // Dropping the session is what makes the next action ask again — the only
  // way for the user to add the monitor.
  assertEquals(portal.sessions.at(0)?.closed, true);
  await host.act({ kind: "click", x: 400, y: 100, button: "left", count: 1 });
  assertEquals(portal.sessions.length, 2);
  host.close();
});

Deno.test("a failing input call drops the session so the next one can restart it", async () => {
  const { portal, host } = makeHost();
  portal.failMotion = true;
  await assertRejects(
    () => host.act({ kind: "move", x: 400, y: 100 }),
    Error,
    "the session ended",
  );
  assertEquals(portal.sessions.at(0)?.closed, true);
  // The next action opens a fresh session instead of failing forever.
  portal.failMotion = false;
  await host.act({ kind: "move", x: 400, y: 100 });
  assertEquals(portal.sessions.length, 2);
  assertEquals(portal.sessions.at(1)?.motions.at(-1), [12, 80, 100]);
  host.close();
});

Deno.test("closing a host is idempotent and closes the session", async () => {
  const { portal, host } = makeHost();
  await host.act({ kind: "move", x: 400, y: 100 });
  host.close();
  host.close();
  assertEquals(portal.sessions.at(0)?.closed, true);
  assertEquals(portal.disconnected, true);
});

// --- creation ---------------------------------------------------------------

Deno.test("no session bus means no host, and the reason says so", async () => {
  // The verdict is the portal's, so an environment with no bus address at
  // all is the one thing that must still report a reason (and it must name
  // what is missing: the settings toggle shows this sentence).
  const result = await createWaylandComputerHost({
    env: { get: () => undefined },
  });
  assertEquals(result.available, false);
  if (result.available) return;
  assert(
    result.reason.includes("session bus"),
    `the reason must name the missing session bus: ${result.reason}`,
  );
});

Deno.test("the display variables do not decide availability", async () => {
  // A server started by systemd has the session bus but not the session's
  // display variables (gnome-session publishes those to the bus's activation
  // environment, which reaches a unit only when the desktop was already up).
  // The portal is the only thing that knows whether the desktop can be
  // driven, so an environment without WAYLAND_DISPLAY must not be turned
  // into a reason on its own.
  //
  // This machine answers with whatever it is: the assertion is that the
  // verdict does not change when the variable disappears, which is what a
  // systemd-started server experiences.
  const withDisplay = await createWaylandComputerHost({
    env: {
      get: (key: string) => key === "WAYLAND_DISPLAY" ? "wayland-0" : undefined,
    },
  });
  const withoutDisplay = await createWaylandComputerHost({
    env: { get: () => undefined },
  });
  if (withDisplay.available) withDisplay.host.close();
  if (withoutDisplay.available) withoutDisplay.host.close();
  assertEquals(
    withoutDisplay.available,
    withDisplay.available,
    "the presence of WAYLAND_DISPLAY must not change the verdict",
  );
});

Deno.test("the key parsing errors reach the caller", async () => {
  const { host } = makeHost();
  await assertRejects(
    () => host.act({ kind: "key", key: "nope+nope" }),
    Error,
    "more than one key",
  );
  host.close();
});
