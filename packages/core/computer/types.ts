/**
 * ComputerHost: the interface the agent's computer-use tools talk to, plus
 * every domain type shared between the host implementations (today Windows
 * and Wayland/GNOME) and the tool layer.
 *
 * The host abstracts "this machine's screen, mouse and keyboard". It is
 * deliberately platform-neutral in shape: a host captures pixels and
 * injects input; scaling, PNG encoding and the image-to-screen coordinate
 * mapping live in the tool layer (computer/image.ts, computer/tools.ts), so
 * a new platform only has to bring pixels and input — never image code.
 *
 * SCREEN UNITS. Coordinates and rectangles are expressed in the host's own
 * screen unit, which every host documents:
 *
 * - Windows: physical pixels of the virtual desktop (the space the process
 *   sees once it is per-monitor DPI aware). A monitor left of the primary
 *   one has negative x. One screen unit is one captured pixel.
 * - Wayland/GNOME: logical pixels of the desktop bounding box (the
 *   compositor's coordinate space, shifted so the bounding box starts at
 *   (0, 0)). One screen unit is `scale` physical pixels on a monitor, and a
 *   capture is painted at the largest monitor scale, so captured pixels are
 *   NOT 1:1 with screen units there — `RawCapture.screen` names the region
 *   in screen units, and encodeCapture() derives the ratio the agent uses
 *   from the capture's pixel size.
 */

/** A rectangle in physical screen pixels (virtual-desktop coordinates). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** One display (monitor) of the machine. */
export interface DisplayInfo {
  /** 0-based index in the host's enumeration order; `computer_screenshot`
   * takes this index. */
  index: number;
  /** Whether this is the primary display (the one the desktop places at its
   * origin). */
  primary: boolean;
  /** Bounds in screen units (see the module docs). */
  bounds: Rect;
}

/** A captured frame at 1:1: BGRA pixels plus the screen region they cover.
 * Scaling and encoding happen in computer/image.ts, so every host returns
 * the same shape regardless of platform. */
export interface RawCapture {
  /** Screen region the pixels cover, in screen units (see the module
   * docs). */
  screen: Rect;
  /** 32-bit BGRA, top-down, tightly packed (width × height × 4 bytes). May
   * be denser than `screen` (one pixel per screen unit × the platform's
   * capture scale), which is what the reported image scale accounts for. */
  pixels: Uint8Array;
  width: number;
  height: number;
}

export type MouseButton = "left" | "right" | "middle";

/**
 * One action to perform on the machine. Every coordinate is in SCREEN
 * pixels (the tool layer converts from the screenshot's image pixels);
 * durations are fixed by the host (see windows.ts) so a run is
 * reproducible and no caller can invent its own timing.
 */
export type ComputerAction =
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; x: number; y: number; button: MouseButton; count: number }
  | { kind: "drag"; from: Point; to: Point; button: MouseButton }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "focus_window"; window: string }
  | { kind: "wait"; durationMs: number };

/** What one action did, for the tool result. */
export interface ComputerActionResult {
  /** Cursor position after the action (screen units), or undefined when the
   * platform cannot report the pointer (Wayland: the compositor does not
   * publish it). */
  cursor?: Point;
  /** How many input events the pointer movement was interpolated into
   * (0 for actions that do not move the pointer). */
  steps: number;
  /** Measured duration of the action's movement and holds (ms). */
  durationMs: number;
  /** Foreground window after a keyboard action, so the agent can tell
   * whether its typing went where it expected. */
  window?: WindowInfo;
}

/** One top-level window of the machine. */
export interface WindowInfo {
  /** Platform handle: a hex string on Windows (`0x000A0B2C`), stable for
   * the lifetime of the window and meaningless after a reboot. */
  id: string;
  title: string;
  /** Bounds in screen units (see the module docs). */
  bounds: Rect;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
}

/** What a host can do beyond pixels and input. A platform that cannot see
 * windows (Wayland) says so here rather than reporting an empty list, which
 * would read as "this desktop has no windows". */
export interface ComputerCapabilities {
  /** Whether `windows()` lists windows and `focus_window` can bring one
   * forward. */
  windows: boolean;
  /** Whether `cursor()` reports the real pointer position. */
  cursor: boolean;
}

/**
 * The machine the agent drives. Implementations are platform hosts; the
 * tool layer never knows which one backs it.
 */
export interface ComputerHost {
  /** One-line description of the host (platform + screen), for the server's
   * startup log and the settings error text. */
  describe(): string;
  capabilities: ComputerCapabilities;
  displays(): DisplayInfo[];
  /** Capture a region at 1:1 (BGRA, see RawCapture). Throws with a clear
   * message when the screen cannot be captured (no display, protected
   * surface, the user declined, ...). */
  capture(region: Rect): Promise<RawCapture>;
  act(action: ComputerAction): Promise<ComputerActionResult>;
  /** Top-level windows with a non-empty title, in z-order (topmost first).
   * Empty on a platform that cannot enumerate them (see capabilities). */
  windows(): WindowInfo[];
  /** The pointer position in screen units, or undefined when the platform
   * cannot report it (Wayland). */
  cursor(): Point | undefined;
  /** Release the platform resources. Idempotent. */
  close(): void;
}

/** Result of attaching a host: either one, or the reason there is none.
 * The reason is user-facing (it is what the settings toggle reports), so it
 * is a full sentence, never a bare code. */
export type ComputerHostResult =
  | { available: true; host: ComputerHost }
  | { available: false; reason: string };
