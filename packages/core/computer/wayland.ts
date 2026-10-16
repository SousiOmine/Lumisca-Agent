/**
 * The Wayland computer host: this machine's screen, pointer and keyboard
 * through xdg-desktop-portal, which is the only way a background process can
 * reach a Wayland compositor at all.
 *
 * What the compositor gives and what it withholds decides the shape of this
 * file:
 *
 * - A screenshot is ONE whole-desktop image, painted at `S = max(monitor
 *   scales)` pixels per logical pixel (Clutter picks the largest scale among
 *   the monitors the capture touches and upscales the rest), so a region is
 *   a crop and a coordinate is a division by S.
 * - Input is absolute and per stream, in the monitor's own physical pixel
 *   grid: mutter converts with `logical = monitor + stream / scale`. The
 *   per-monitor scale is therefore needed for every click, and a point is
 *   resolved to the monitor — and the stream — that contains it.
 * - Windows cannot be enumerated and the pointer cannot be queried: a
 *   Wayland client cannot see another client's surfaces, and the portal has
 *   no "where is the pointer" call. capabilities says so once, so the tools
 *   can report it instead of pretending the desktop has no windows.
 *
 * The screen-sharing session (the consent dialog) is created on the first
 * input action, never at startup: a server that popped a dialog while it
 * booted would be hostile. Screenshots need their own permission, which the
 * portal asks for on the first capture.
 */
import { CoreError } from "../errors.ts";
import {
  charKeysym,
  keyKeysym,
  KEYSYM_RETURN,
  MODIFIER_KEYSYMS,
} from "./keysyms.ts";
import {
  CLICK_HOLD_MS,
  DRAG_HOLD_MS,
  DRAG_MS,
  HOVER_SETTLE_MS,
  interpolatePoint,
  MOVE_MS,
  MOVE_TICK_MS,
  parseKeyChord,
  sleep,
  splitTypeText,
} from "./motion.ts";
import { describeMonitor } from "./portal/display-config.ts";
import { type PortalProbeOptions, probePortal } from "./portal/client.ts";
import type {
  LogicalMonitor,
  MonitorLayout,
  PortalClient,
  PortalSession,
  PortalStream,
  ScreenImage,
} from "./portal/types.ts";
import type {
  ComputerAction,
  ComputerActionResult,
  ComputerCapabilities,
  ComputerHost,
  ComputerHostResult,
  DisplayInfo,
  MouseButton,
  Point,
  RawCapture,
  Rect,
  WindowInfo,
} from "./types.ts";

export type WaylandHostOptions = PortalProbeOptions;

/** The Wayland host of this machine, or why there is none. */
export async function createWaylandComputerHost(
  options: WaylandHostOptions = {},
): Promise<ComputerHostResult> {
  const env = options.env ?? Deno.env;
  const display = env.get("WAYLAND_DISPLAY");
  if (display === undefined || display.length === 0) {
    return {
      available: false,
      reason:
        "the server is not running inside a Wayland session (WAYLAND_DISPLAY is not set), which computer use on Linux needs",
    };
  }
  const probe = await probePortal(options);
  if (!probe.available) return { available: false, reason: probe.reason };
  return {
    available: true,
    host: new WaylandComputerHost(probe.client, probe.layout),
  };
}

/** The host itself: the coordinate arithmetic (screen units ↔ the capture's
 * pixel grid ↔ a monitor's stream grid) around a portal client. Exported for
 * tests, which drive it with a fake client — on a machine with one display
 * the mixed-DPI arithmetic is otherwise unreachable. */
export class WaylandComputerHost implements ComputerHost {
  private layout: MonitorLayout;
  private session: PortalSession | undefined;
  /** Where the last commanded movement ended, in screen units. The pointer
   * itself cannot be read, so this is what an interpolated movement starts
   * from (and it is why nothing here claims to know the real position). */
  private lastPointer: Point | undefined;
  private closed = false;

  readonly capabilities: ComputerCapabilities = {
    windows: false,
    cursor: false,
  };

  constructor(
    private readonly client: PortalClient,
    layout: MonitorLayout,
  ) {
    this.layout = layout;
  }

  describe(): string {
    const monitors = this.layout.monitors.map((monitor) =>
      `${monitor.width}×${monitor.height} scale ${monitor.scale}` +
      (monitor.primary ? " primary" : "")
    );
    const count = monitors.length === 1
      ? "1 display"
      : `${monitors.length} displays`;
    return `GNOME (Wayland), ${count}: ${monitors.join(", ")}`;
  }

  displays(): DisplayInfo[] {
    return this.layout.monitors.map((monitor, index) => ({
      index,
      primary: monitor.primary,
      bounds: this.screenBounds(monitor),
    }));
  }

  cursor(): Point | undefined {
    // Wayland has no "where is the pointer" query for other clients, and the
    // portal does not add one.
    return undefined;
  }

  windows(): WindowInfo[] {
    return [];
  }

  async capture(region: Rect): Promise<RawCapture> {
    await this.refreshLayout();
    const image = await this.client.captureScreen();
    const scaleX = image.width / this.layout.width;
    const scaleY = image.height / this.layout.height;
    if (
      Math.abs(scaleX * this.layout.height - image.height) > 1 ||
      Math.abs(scaleX - scaleY) > 1 / Math.max(1, this.layout.height)
    ) {
      throw new CoreError(
        `the screenshot (${image.width}×${image.height}) does not match the ` +
          `desktop this host knows (${this.layout.width}×` +
          `${this.layout.height}); the display layout changed — try again`,
        "unavailable",
      );
    }
    // The image covers the desktop bounding box, which IS this host's screen
    // space: screen (0, 0) is the image's (0, 0), so only the scale remains.
    const x = Math.round(region.x * scaleX);
    const y = Math.round(region.y * scaleY);
    const width = Math.max(1, Math.round(region.width * scaleX));
    const height = Math.max(1, Math.round(region.height * scaleY));
    if (
      x < 0 || y < 0 || x + width > image.width || y + height > image.height
    ) {
      throw new CoreError(
        `the region (${region.x}, ${region.y}) ${region.width}×` +
          `${region.height} is outside the desktop ` +
          `(${this.layout.width}×${this.layout.height})`,
        "invalid",
      );
    }
    return {
      screen: region,
      pixels: cropBgra(image, x, y, width, height),
      width,
      height,
    };
  }

  async act(action: ComputerAction): Promise<ComputerActionResult> {
    const started = Date.now();
    switch (action.kind) {
      case "move": {
        const steps = await this.movePointer(action.x, action.y, MOVE_MS);
        return { steps, durationMs: Date.now() - started };
      }
      case "click": {
        const steps = await this.movePointer(action.x, action.y, MOVE_MS);
        await sleep(HOVER_SETTLE_MS);
        for (let i = 0; i < action.count; i++) {
          await this.pointerButton(action.button, true);
          await sleep(CLICK_HOLD_MS);
          await this.pointerButton(action.button, false);
          if (i + 1 < action.count) await sleep(CLICK_HOLD_MS);
        }
        return { steps, durationMs: Date.now() - started };
      }
      case "drag": {
        const approach = await this.movePointer(
          action.from.x,
          action.from.y,
          MOVE_MS,
        );
        await sleep(HOVER_SETTLE_MS);
        await this.pointerButton(action.button, true);
        await sleep(DRAG_HOLD_MS);
        const path = await this.movePointer(action.to.x, action.to.y, DRAG_MS);
        await sleep(HOVER_SETTLE_MS);
        await this.pointerButton(action.button, false);
        return { steps: approach + path, durationMs: Date.now() - started };
      }
      case "scroll": {
        const steps = await this.movePointer(action.x, action.y, MOVE_MS);
        await sleep(HOVER_SETTLE_MS);
        if (action.deltaY !== 0) {
          await this.withSession((session) =>
            session.pointerAxisDiscrete("vertical", action.deltaY)
          );
        }
        if (action.deltaX !== 0) {
          await this.withSession((session) =>
            session.pointerAxisDiscrete("horizontal", action.deltaX)
          );
        }
        return { steps, durationMs: Date.now() - started };
      }
      case "type": {
        await this.typeText(action.text);
        return { steps: 0, durationMs: Date.now() - started };
      }
      case "key": {
        await this.pressKey(action.key);
        return { steps: 0, durationMs: Date.now() - started };
      }
      case "focus_window": {
        throw new CoreError(
          "focusing a window by its id is not possible on Wayland: the " +
            "desktop does not tell the agent which windows exist. Press " +
            '"alt+tab" (computer_act action "key") to switch windows, or ' +
            "click the one you mean from a screenshot.",
          "unavailable",
        );
      }
      case "wait": {
        await sleep(action.durationMs);
        return { steps: 0, durationMs: Date.now() - started };
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const session = this.session;
    this.session = undefined;
    // The screen-sharing session asks the portal to drop it; a session that
    // is already gone is not an error (see remote-desktop.ts).
    if (session !== undefined) void session.close();
    this.client.disconnect();
  }

  // --- internals ------------------------------------------------------------

  /** Re-read the layout so a monitor plugged in after startup is picked up.
   * A failure keeps the cached layout: it was correct when the host was
   * created, and a capture or an action is a better place to report a
   * compositor that went away than a refresh nobody asked for. */
  private async refreshLayout(): Promise<void> {
    try {
      this.layout = await this.client.monitorLayout();
    } catch {
      // Keep the layout from the last successful read.
    }
  }

  /** A monitor's bounds in this host's screen space: the compositor's
   * coordinate space shifted so the desktop bounding box starts at (0, 0).
   * The shift is what makes a monitor placed left of or above the primary
   * one addressable (its compositor coordinates are negative). */
  private screenBounds(monitor: LogicalMonitor): Rect {
    return {
      x: monitor.x - this.layout.x,
      y: monitor.y - this.layout.y,
      width: monitor.width,
      height: monitor.height,
    };
  }

  /** The monitor containing a screen point; the nearest one when the point
   * falls in a gap between monitors of different sizes (a drag path crosses
   * those). Mutter converts stream coordinates with the stream's own
   * geometry and does not clamp, so the nearest monitor carries it. */
  private monitorAt(point: Point): LogicalMonitor {
    const monitors = this.layout.monitors;
    const inside = monitors.find((monitor) =>
      containsPoint(this.screenBounds(monitor), point)
    );
    if (inside !== undefined) return inside;
    return monitors.reduce((best, monitor) =>
      distanceToRect(this.screenBounds(monitor), point) <
          distanceToRect(this.screenBounds(best), point)
        ? monitor
        : best
    );
  }

  /** The stream that shows a monitor: by connector name, which is what the
   * portal's metadata and the layout have in common, with the geometry as
   * the fallback for a compositor that publishes no name. */
  private streamFor(
    session: PortalSession,
    monitor: LogicalMonitor,
  ): PortalStream {
    const byConnector = session.streams.find((stream) =>
      stream.connectors.some((connector) =>
        monitor.connectors.includes(connector)
      )
    );
    if (byConnector !== undefined) {
      return byConnector;
    }
    const byGeometry = session.streams.find((stream) =>
      stream.position.x === monitor.x &&
      stream.position.y === monitor.y &&
      stream.size.width === monitor.width &&
      stream.size.height === monitor.height
    );
    if (byGeometry !== undefined) {
      return byGeometry;
    }
    // The user shared other monitors only. Dropping the session makes the
    // next action ask again, which is the only way to change the selection.
    this.forgetSession();
    throw new CoreError(
      `the desktop did not share ${describeMonitor(monitor)} with the agent; ` +
        "the next action will ask again — include that monitor in the " +
        "sharing dialog",
      "unavailable",
    );
  }

  /** The screen-sharing session, creating it (and asking the user) on first
   * use. */
  private async requireSession(): Promise<PortalSession> {
    if (this.session === undefined) {
      this.session = await this.client.openSession();
      // A fresh session knows nothing about where the pointer is.
      this.lastPointer = undefined;
    }
    return this.session;
  }

  private forgetSession(): void {
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) void session.close();
  }

  /** Run one input call against the session, dropping the session when it
   * fails: a session can end under us (the compositor restarted, the user
   * stopped sharing), and the next action should establish a fresh one
   * instead of failing forever. */
  private async withSession<T>(
    work: (session: PortalSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.requireSession();
    try {
      return await work(session);
    } catch (error) {
      this.forgetSession();
      throw error;
    }
  }

  private async pointerButton(
    button: MouseButton,
    pressed: boolean,
  ): Promise<void> {
    await this.withSession((session) => session.pointerButton(button, pressed));
  }

  /** One interpolated pointer movement to a screen point, in stream
   * coordinates. Returns how many move events it took. */
  private async movePointer(
    x: number,
    y: number,
    durationMs: number,
  ): Promise<number> {
    const target = { x, y };
    const from = this.lastPointer ?? target;
    const started = Date.now();
    let steps = 0;
    for (;;) {
      const ratio = durationMs <= 0
        ? 1
        : Math.min(1, (Date.now() - started) / durationMs);
      await this.sendAbsolute(interpolatePoint(from, target, ratio));
      steps++;
      if (ratio >= 1) break;
      await sleep(MOVE_TICK_MS);
    }
    this.lastPointer = target;
    return steps;
  }

  private async sendAbsolute(point: Point): Promise<void> {
    const monitor = this.monitorAt(point);
    await this.withSession(async (session) => {
      const stream = this.streamFor(session, monitor);
      const bounds = this.screenBounds(monitor);
      // The stream's grid is the monitor's physical pixels: the portal
      // divides by the scale to get back to logical coordinates.
      await session.pointerMotionAbsolute(
        stream.id,
        (point.x - bounds.x) * monitor.scale,
        (point.y - bounds.y) * monitor.scale,
      );
    });
  }

  /** Type text at the current focus. Each character is injected by its
   * keysym, so the layout never has to be known here; a newline is a real
   * Enter press (see motion.ts's splitTypeText). */
  private async typeText(text: string): Promise<void> {
    for (const segment of splitTypeText(text)) {
      if (segment.kind === "enter") {
        await this.pressKeysym(KEYSYM_RETURN);
        continue;
      }
      for (const character of segment.value) {
        await this.pressKeysym(charKeysym(character));
      }
    }
  }

  /** Press a key or chord: modifiers down, key down, key up, modifiers up. */
  private async pressKey(chord: string): Promise<void> {
    const parsed = parseKeyChord(chord);
    const keysym = keyKeysym(parsed.key);
    const modifiers = parsed.modifiers.map((name) => MODIFIER_KEYSYMS[name]);
    await this.withSession(async (session) => {
      for (const modifier of modifiers) {
        await session.keyboardKeysym(modifier, true);
      }
      await session.keyboardKeysym(keysym, true);
      await session.keyboardKeysym(keysym, false);
      for (const modifier of [...modifiers].reverse()) {
        await session.keyboardKeysym(modifier, false);
      }
    });
  }

  private async pressKeysym(keysym: number): Promise<void> {
    await this.withSession(async (session) => {
      await session.keyboardKeysym(keysym, true);
      await session.keyboardKeysym(keysym, false);
    });
  }
}

function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width &&
    point.y >= rect.y && point.y < rect.y + rect.height;
}

/** Distance from a point to a rectangle (0 inside it). */
function distanceToRect(rect: Rect, point: Point): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width - 1));
  const dy = Math.max(
    rect.y - point.y,
    0,
    point.y - (rect.y + rect.height - 1),
  );
  return Math.hypot(dx, dy);
}

/** Copy one region of a captured image (BGRA rows). */
function cropBgra(
  image: ScreenImage,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4;
    out.set(image.pixels.subarray(from, from + width * 4), row * width * 4);
  }
  return out;
}
