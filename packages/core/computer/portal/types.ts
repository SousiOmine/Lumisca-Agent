/**
 * The types the Wayland computer host and the xdg-desktop-portal client
 * share. They describe the compositor's coordinate space and the two portal
 * services the host drives; the D-Bus shapes themselves stay inside
 * connection.ts and the modules that speak to the bus.
 *
 * Coordinate spaces, because three of them meet here:
 *
 * - The COMPOSITOR (logical) space: what the user sees. The primary monitor
 *   is at (0, 0) and a monitor placed left of or above it has negative
 *   coordinates, so the desktop origin is not necessarily (0, 0).
 * - The IMAGE space: one whole-desktop screenshot. GNOME paints it at a
 *   single scale S = the largest monitor scale, upscaling the monitors that
 *   are scaled less, so image xy = (logical xy - desktop origin) * S.
 * - The STREAM space: what `NotifyPointerMotionAbsolute` takes. Mutter
 *   converts it with `logical = monitor + stream / monitor.scale`, i.e. the
 *   stream's own physical pixel grid — a per-monitor scale the portal
 *   metadata does not carry, which is why the monitor layout is read from
 *   org.gnome.Mutter.DisplayConfig instead.
 */
import type { MouseButton } from "../types.ts";

/** One logical monitor of the compositor's layout. */
export interface LogicalMonitor {
  /** Position in the compositor's coordinate space (see the module docs). */
  x: number;
  y: number;
  /** Logical size (physical pixels divided by the scale). */
  width: number;
  height: number;
  /** Physical pixels per logical pixel (1, 1.25, 1.5, 2, ...). */
  scale: number;
  primary: boolean;
  /** Connector names ("DP-1", "Virtual-1"): how a screen-cast stream is
   * matched to the monitor it shows. */
  connectors: readonly string[];
}

/** Every logical monitor plus the bounding box they occupy. The bounding
 * box is the space this host reports: screenshots cover it, and `bounds` of
 * a display is relative to its origin. */
export interface MonitorLayout {
  monitors: readonly LogicalMonitor[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One decoded screen capture: BGRA pixels (what the image pipeline
 * consumes) and the image size in pixels. */
export interface ScreenImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** One screen-cast stream: a monitor the user shared with the agent, in
 * the compositor's logical space. */
export interface PortalStream {
  /** Node id the portal gave the stream; input calls name it. */
  id: number;
  connectors: readonly string[];
  position: { x: number; y: number };
  size: { width: number; height: number };
}

/** A screen-casting session with input. Creating one asks the user for
 * permission; `restoreToken` lets the next one skip the dialog. */
export interface PortalSession {
  readonly streams: readonly PortalStream[];
  /** Pass this to the next session to keep the permission. */
  readonly restoreToken?: string;
  pointerMotionAbsolute(streamId: number, x: number, y: number): Promise<void>;
  pointerButton(button: MouseButton, pressed: boolean): Promise<void>;
  pointerAxisDiscrete(
    axis: "vertical" | "horizontal",
    steps: number,
  ): Promise<void>;
  /** Inject one key by keysym (see keysyms.ts): the compositor maps it to a
   * keycode and the modifiers that produce it. */
  keyboardKeysym(keysym: number, pressed: boolean): Promise<void>;
  close(): Promise<void>;
}

/** The portal services the Wayland host uses, as one object so tests can
 * stand in for the whole bus. */
export interface PortalClient {
  /** The compositor's monitor layout. Only GNOME's DisplayConfig publishes
   * one, so a desktop without it has no host at all. */
  monitorLayout(): Promise<MonitorLayout>;
  /** One whole-desktop screenshot. Consumes the user's screenshot
   * permission, which the portal asks for on first use. */
  captureScreen(): Promise<ScreenImage>;
  /** A screen-casting session with pointer and keyboard input, creating one
   * (and asking the user) when there is none. */
  openSession(): Promise<PortalSession>;
  /** Close the bus connection. Idempotent. */
  disconnect(): void;
}

/** Where a restore token is kept between runs: the portal hands one out
 * after the user allows screen sharing, and passing it back is what keeps
 * the later sessions dialog-free. */
export interface RestoreTokenStore {
  load(): string | undefined;
  save(token: string): void;
}
