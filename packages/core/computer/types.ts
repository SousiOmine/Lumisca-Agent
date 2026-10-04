/**
 * ComputerHost: the interface the agent's computer-use tools talk to, plus
 * every domain type shared between the host implementations (today the
 * Windows host) and the tool layer.
 *
 * The host abstracts "this machine's screen, mouse and keyboard". It is
 * deliberately platform-neutral in shape: a host captures pixels and
 * injects input; scaling, PNG encoding and the image-to-screen coordinate
 * mapping live in the tool layer (computer/image.ts, computer/tools.ts), so
 * a new platform only has to bring pixels and input — never image code.
 *
 * Coordinates are PHYSICAL pixels in the virtual-desktop space (the space
 * Windows reports when the process is per-monitor DPI aware). A monitor
 * left of the primary one has negative x, exactly as the OS arranges it.
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
  /** Whether this is the primary display (the one Windows puts at 0,0). */
  primary: boolean;
  /** Physical-pixel bounds in virtual-desktop coordinates. */
  bounds: Rect;
}

/** What a capture covers: the host captures a rect; which rect (a display,
 * an explicit region) is the tool layer's policy — it owns the display list
 * and the error messages that name it. */
export interface CaptureOptions {
  /** Region in virtual-desktop coordinates (negative allowed). Must
   * intersect at least one display. */
  region: Rect;
}

/** A captured frame at 1:1: BGRA pixels plus the screen region they cover.
 * Scaling and encoding happen in computer/image.ts, so every host returns
 * the same shape regardless of platform. */
export interface RawCapture {
  /** Screen region the pixels cover (physical pixels). */
  screen: Rect;
  /** 32-bit BGRA, top-down, tightly packed (width × height × 4 bytes). */
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
  /** Cursor position after the action (screen pixels). */
  cursor: Point;
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
  /** Window handle as a hex string (`0x000A0B2C`); stable for the lifetime
   * of the window, meaningless after a reboot. */
  id: string;
  title: string;
  /** Physical-pixel bounds in virtual-desktop coordinates. */
  bounds: Rect;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
}

/**
 * The machine the agent drives. Implementations are platform hosts; the
 * tool layer never knows which one backs it.
 */
export interface ComputerHost {
  /** One-line description of the host (platform + screen), for the server's
   * startup log and the settings error text. */
  describe(): string;
  displays(): DisplayInfo[];
  /** Capture a region at 1:1 (BGRA). Throws with a clear message when the
   * screen cannot be captured (no display, protected surface, ...). */
  capture(region: Rect): Promise<RawCapture>;
  act(action: ComputerAction): Promise<ComputerActionResult>;
  /** Top-level windows with a non-empty title, in z-order (topmost first). */
  windows(): WindowInfo[];
  cursor(): Point;
  /** Release the platform resources. Idempotent. */
  close(): void;
}

/** Result of attaching a host: either one, or the reason there is none.
 * The reason is user-facing (it is what the settings toggle reports), so it
 * is a full sentence, never a bare code. */
export type ComputerHostResult =
  | { available: true; host: ComputerHost }
  | { available: false; reason: string };
