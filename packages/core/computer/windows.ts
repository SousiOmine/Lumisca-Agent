/**
 * The Windows computer host: screen capture over GDI, input injection over
 * SendInput, window enumeration over the Win32 window list — all reached
 * through Deno's FFI, so the server needs no native module of its own (the
 * packaged server already ships `--allow-ffi` for Skia).
 *
 * Decisions worth knowing before changing anything here:
 *
 * - **Physical pixels only.** The host makes the process per-monitor DPI
 *   aware at creation and REFUSES to run when it cannot verify that: with
 *   any other awareness the screen metrics are virtualized, and every
 *   coordinate the agent reads off a screenshot would be wrong on a scaled
 *   display. Failing fast beats clicking at the wrong place.
 * - **A monitor rect is the source of truth** (`EnumDisplayMonitors` +
 *   `GetMonitorInfoW`), not the aggregated virtual-screen metrics: mixed
 *   DPI setups are exactly where the aggregated values get reinterpreted.
 *   The virtual-screen metrics are used for one thing only — normalizing
 *   SendInput's absolute coordinates, which is what `VIRTUALDESK` expects.
 * - **Movement is interpolated, never teleported.** A pointer that jumps
 *   straight to its target does not update hover-dependent UI, does not
 *   start drags, and is ignored by apps that watch the pointer. Every
 *   movement therefore walks the straight line over a fixed duration
 *   (MOVE_MS for moves and approaches, DRAG_MS for a drag path), and holds
 *   still before pressing and releasing. The durations are constants, not
 *   arguments: a run stays reproducible, and the agent cannot invent its
 *   own timing. No jitter or acceleration either — a deterministic path is
 *   what makes a failure diagnosable.
 * - **Windows are enumerated in z-order** and reported with their screen
 *   rect, so the agent can tell which display a window is on and which one
 *   holds the focus.
 *
 * Nothing in this module touches the OS until createWindowsComputerHost()
 * runs, so importing it on any platform is safe (host.ts picks the
 * implementation by platform).
 */
import { CoreError, errorMessage } from "../errors.ts";
import type {
  ComputerAction,
  ComputerActionResult,
  ComputerHost,
  ComputerHostResult,
  DisplayInfo,
  MouseButton,
  Point,
  RawCapture,
  Rect,
  WindowInfo,
} from "./types.ts";

// --- fixed timings ----------------------------------------------------------
// All in milliseconds. They exist so a pointer movement looks like a hand
// moving rather than a jump; see the module docs.

/** Duration of a pointer move (a plain move, the approach before a click,
 * the reposition before a wheel). */
export const MOVE_MS = 100;
/** Duration of a drag path. Longer than MOVE_MS because a drop target has
 * to see the button held down while the pointer travels. */
export const DRAG_MS = 300;
/** Stillness after arriving, before pressing: lets hover state settle. */
export const HOVER_SETTLE_MS = 60;
/** How long a button stays down for one click. */
export const CLICK_HOLD_MS = 40;
/** Stillness after pressing, before a drag starts: lets the app enter drag
 * mode. */
export const DRAG_HOLD_MS = 100;
/** Interval between two interpolation steps (Windows' timer granularity
 * makes the real step ~15ms; the total still honors the requested
 * duration because the loop is deadline-based). */
export const MOVE_TICK_MS = 10;
/** Stillness after activating a window, before its handle is verified. */
export const FOCUS_SETTLE_MS = 60;
/** Characters sent per SendInput call while typing (two events each). */
export const TYPE_CHUNK_CHARS = 128;
/** Longest window title reported (WCHARs; longer titles are cut). */
export const MAX_WINDOW_TITLE_CHARS = 512;

// --- Win32 constants --------------------------------------------------------

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
/** One wheel notch (WHEEL_DELTA). */
const WHEEL_DELTA = 120;
const SRCCOPY = 0x00cc0020;
const SW_RESTORE = 9;
/** DPI_AWARENESS_PER_MONITOR_AWARE (the value GetAwarenessFrom… returns). */
const DPI_AWARENESS_PER_MONITOR_AWARE = 2;
/** DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: the API names this context
 * with a pseudo-handle (the address -4) rather than an enum value. */
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;
/** Virtual-screen metrics of GetSystemMetrics. */
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
/** MONITORINFOF_PRIMARY. */
const MONITORINFOF_PRIMARY = 1;
/** VK codes of the modifier keys (VK_LWIN for the Windows key). */
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
/** Enter: the key a newline in a `type` action becomes. */
const VK_RETURN = 0x0d;
/** WM_IME_CONTROL with its IMC_* sub-commands (imm.h): how a window's IME
 * is queried and switched off from another process. */
const WM_IME_CONTROL = 0x0283;
const IMC_GETOPENSTATUS = 0x0005;
const IMC_SETOPENSTATUS = 0x0006;
/** SendMessageTimeout flags: never wait on a hung window. */
const SMTO_ABORTIFHUNG = 0x0002;
/** Upper bound for one cross-process IME message. */
const IME_MESSAGE_TIMEOUT_MS = 250;

// --- FFI bindings -----------------------------------------------------------
// Declared as module constants so the libraries' symbol types are inferred
// precisely; the libraries themselves are opened by the factory below.

const USER32_SYMBOLS = {
  SetProcessDpiAwarenessContext: { parameters: ["pointer"], result: "i32" },
  GetThreadDpiAwarenessContext: { parameters: [], result: "pointer" },
  GetAwarenessFromDpiAwarenessContext: {
    parameters: ["pointer"],
    result: "i32",
  },
  GetSystemMetrics: { parameters: ["i32"], result: "i32" },
  GetCursorPos: { parameters: ["buffer"], result: "i32" },
  SendInput: { parameters: ["u32", "buffer", "i32"], result: "u32" },
  GetDC: { parameters: ["pointer"], result: "pointer" },
  ReleaseDC: { parameters: ["pointer", "pointer"], result: "i32" },
  EnumDisplayMonitors: {
    parameters: ["pointer", "pointer", "pointer", "pointer"],
    result: "i32",
  },
  GetMonitorInfoW: { parameters: ["pointer", "buffer"], result: "i32" },
  EnumWindows: { parameters: ["pointer", "pointer"], result: "i32" },
  GetWindowTextW: { parameters: ["pointer", "buffer", "i32"], result: "i32" },
  GetWindowRect: { parameters: ["pointer", "buffer"], result: "i32" },
  IsWindowVisible: { parameters: ["pointer"], result: "i32" },
  IsIconic: { parameters: ["pointer"], result: "i32" },
  IsWindow: { parameters: ["pointer"], result: "i32" },
  GetForegroundWindow: { parameters: [], result: "pointer" },
  SetForegroundWindow: { parameters: ["pointer"], result: "i32" },
  ShowWindow: { parameters: ["pointer", "i32"], result: "i32" },
  VkKeyScanW: { parameters: ["u16"], result: "i16" },
  SendMessageTimeoutW: {
    parameters: [
      "pointer",
      "u32",
      "pointer",
      "pointer",
      "u32",
      "u32",
      "buffer",
    ],
    result: "pointer",
  },
} satisfies Deno.ForeignLibraryInterface;

/** imm32: the IME of a window, needed to keep an open IME from intercepting
 * injected characters (see WindowsComputerHost.withImeOff). */
const IMM32_SYMBOLS = {
  ImmGetDefaultIMEWnd: { parameters: ["pointer"], result: "pointer" },
} satisfies Deno.ForeignLibraryInterface;

const GDI32_SYMBOLS = {
  CreateCompatibleDC: { parameters: ["pointer"], result: "pointer" },
  CreateCompatibleBitmap: {
    parameters: ["pointer", "i32", "i32"],
    result: "pointer",
  },
  SelectObject: { parameters: ["pointer", "pointer"], result: "pointer" },
  BitBlt: {
    parameters: [
      "pointer",
      "i32",
      "i32",
      "i32",
      "i32",
      "pointer",
      "i32",
      "i32",
      "u32",
    ],
    result: "i32",
  },
  GetDIBits: {
    parameters: ["pointer", "pointer", "u32", "u32", "buffer", "buffer", "u32"],
    result: "i32",
  },
  DeleteObject: { parameters: ["pointer"], result: "i32" },
  DeleteDC: { parameters: ["pointer"], result: "i32" },
} satisfies Deno.ForeignLibraryInterface;

type User32 = Deno.DynamicLibrary<typeof USER32_SYMBOLS>;
type Gdi32 = Deno.DynamicLibrary<typeof GDI32_SYMBOLS>;
type Imm32 = Deno.DynamicLibrary<typeof IMM32_SYMBOLS>;

/** Pointer width of this process (both Windows targets Deno builds for are
 * 64-bit, but the input structs are built from the width rather than
 * assumed). */
export function pointerSizeFor(arch: string): number {
  return arch === "x86_64" || arch === "aarch64" ? 8 : 4;
}

/** Size of one INPUT structure for a pointer width: `DWORD type`, padding
 * to the union's alignment, then the union (MOUSEINPUT is its largest
 * member — 32 bytes on 64-bit, 24 on 32-bit). */
export function inputSize(pointerSize: number): number {
  return pointerSize === 8 ? 40 : 28;
}

/** Byte offset of the union inside an INPUT structure. */
function unionOffset(pointerSize: number): number {
  return pointerSize === 8 ? 8 : 4;
}

// --- pure helpers (unit-tested without touching the OS) ---------------------

/** The point at `ratio` along the straight line from `from` to `to`. The
 * endpoints are exact (ratio 0 and 1), which is what makes the last step of
 * an interpolated movement land precisely on the target. */
export function interpolatePoint(from: Point, to: Point, ratio: number): Point {
  const t = Math.min(1, Math.max(0, ratio));
  return {
    x: Math.round(from.x + (to.x - from.x) * t),
    y: Math.round(from.y + (to.y - from.y) * t),
  };
}

/** One absolute-coordinate component for SendInput: the value is mapped
 * onto 0..65535 across the whole virtual desktop (VIRTUALDESK), where
 * 65535 is the far edge (extent - 1). */
export function normalizeAbsolute(
  value: number,
  origin: number,
  extent: number,
): number {
  const span = Math.max(1, extent - 1);
  const normalized = Math.round(((value - origin) * 65535) / span);
  return Math.min(65535, Math.max(0, normalized));
}

/** Build one MOUSEINPUT-carrying INPUT structure. */
export function buildMouseInput(
  dx: number,
  dy: number,
  flags: number,
  mouseData: number,
  pointerSize: number,
): Uint8Array {
  const buffer = new Uint8Array(inputSize(pointerSize));
  const view = new DataView(buffer.buffer);
  const base = unionOffset(pointerSize);
  view.setUint32(0, INPUT_MOUSE, true);
  view.setInt32(base, dx, true);
  view.setInt32(base + 4, dy, true);
  view.setUint32(base + 8, mouseData, true);
  view.setUint32(base + 12, flags, true);
  view.setUint32(base + 16, 0, true); // time: let the system stamp it
  return buffer;
}

/** Build one KEYBDINPUT-carrying INPUT structure. `scan` carries the UTF-16
 * code unit when KEYEVENTF_UNICODE is set, and 0 for a virtual key. */
export function buildKeyInput(
  vk: number,
  scan: number,
  flags: number,
  pointerSize: number,
): Uint8Array {
  const buffer = new Uint8Array(inputSize(pointerSize));
  const view = new DataView(buffer.buffer);
  const base = unionOffset(pointerSize);
  view.setUint32(0, INPUT_KEYBOARD, true);
  view.setUint16(base, vk, true);
  view.setUint16(base + 2, scan, true);
  view.setUint32(base + 4, flags, true);
  view.setUint32(base + 8, 0, true); // time: let the system stamp it
  return buffer;
}

/** Join INPUT structures into the array SendInput consumes. */
export function concatInputs(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Typing one UTF-16 code unit: down + up as a Unicode key event. Surrogate
 * pairs are sent as their two code units, which is how the system
 * reassembles a character outside the BMP. */
export function buildUnicodeInputs(
  codeUnits: readonly number[],
  pointerSize: number,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const unit of codeUnits) {
    parts.push(buildKeyInput(0, unit, KEYEVENTF_UNICODE, pointerSize));
    parts.push(
      buildKeyInput(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, pointerSize),
    );
  }
  return concatInputs(parts);
}

/** One piece of a `type` action: literal text sent as Unicode, or a real
 * Enter press. A newline cannot ride along as a Unicode character — the
 * controls drop a CR/LF code unit (measured: "a\r\nb" arrives as "ab") — so
 * it becomes an Enter key press, which is also what a person would do. */
export type TypeSegment =
  | { kind: "text"; value: string }
  | { kind: "enter" };

/** Split typed text into Unicode runs and Enter presses. */
export function splitTypeText(text: string): TypeSegment[] {
  const segments: TypeSegment[] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) segments.push({ kind: "enter" });
    const line = lines[i]!;
    if (line.length > 0) segments.push({ kind: "text", value: line });
  }
  return segments;
}

/** Pressing one key with its modifiers held: modifiers down, key down, key
 * up, modifiers up (in reverse order). */
export function buildKeyChordInputs(
  vk: number,
  modifiers: readonly number[],
  pointerSize: number,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const modifier of modifiers) {
    parts.push(buildKeyInput(modifier, 0, 0, pointerSize));
  }
  parts.push(buildKeyInput(vk, 0, 0, pointerSize));
  parts.push(buildKeyInput(vk, 0, KEYEVENTF_KEYUP, pointerSize));
  for (const modifier of [...modifiers].reverse()) {
    parts.push(buildKeyInput(modifier, 0, KEYEVENTF_KEYUP, pointerSize));
  }
  return concatInputs(parts);
}

/** Named keys accepted in a key chord (lower case). */
const KEY_NAMES: Record<string, number> = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pgup: 0x21,
  pagedown: 0x22,
  pgdn: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  capslock: 0x14,
  numlock: 0x90,
  scrolllock: 0x91,
  printscreen: 0x2c,
  pause: 0x13,
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, 0x70 + i]),
  ),
};

/** Modifier names accepted in a key chord (lower case). */
const MODIFIER_NAMES: Record<string, number> = {
  ctrl: VK_CONTROL,
  control: VK_CONTROL,
  shift: VK_SHIFT,
  alt: VK_MENU,
  win: VK_LWIN,
  meta: VK_LWIN,
  super: VK_LWIN,
};

/** One parsed key chord. */
export interface KeyChord {
  /** Virtual key code of the key itself. */
  vk: number;
  /** Modifier virtual key codes, in press order. */
  modifiers: number[];
}

/**
 * Parse a key chord ("enter", "ctrl+shift+s", "f5", "a", "+") into a
 * virtual key and its modifiers. A single character is resolved through the
 * caller's keyboard-layout lookup (`VkKeyScanW`): a character that needs
 * Shift or AltGr on this layout has those pressed implicitly, which is what
 * "press the key that produces this character" means.
 */
export function resolveKeyChord(
  chord: string,
  scanChar: (char: string) => number | undefined,
): KeyChord {
  const trimmed = chord.trim();
  if (trimmed.length === 0) {
    throw new CoreError("key must not be empty", "invalid");
  }
  // A lone character is the key itself — including "+", which could not be
  // written as a chord (it is the separator).
  const parts = trimmed.length === 1 ? [trimmed] : trimmed.split("+");
  const modifiers: number[] = [];
  let vk: number | undefined;
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const lower = part.toLowerCase();
    const modifier = MODIFIER_NAMES[lower];
    if (modifier !== undefined) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (vk !== undefined) {
      throw new CoreError(
        `key chord "${chord}" names more than one key`,
        "invalid",
      );
    }
    const named = KEY_NAMES[lower];
    if (named !== undefined) {
      vk = named;
      continue;
    }
    if (part.length !== 1) {
      throw new CoreError(
        `unknown key "${part}" in chord "${chord}"`,
        "invalid",
      );
    }
    // The character is looked up as written: its case is what decides
    // whether Shift belongs to the chord ("A" needs it, "a" does not).
    const scanned = scanChar(part);
    if (scanned === undefined) {
      throw new CoreError(
        `no key produces "${part}" on this keyboard layout`,
        "invalid",
      );
    }
    vk = scanned & 0xff;
    // VkKeyScanW's high byte: 1 = shift, 2 = ctrl, 4 = alt (AltGr).
    const state = (scanned >> 8) & 0xff;
    if (state & 1 && !modifiers.includes(VK_SHIFT)) modifiers.push(VK_SHIFT);
    if (state & 2 && !modifiers.includes(VK_CONTROL)) {
      modifiers.push(VK_CONTROL);
    }
    if (state & 4 && !modifiers.includes(VK_MENU)) modifiers.push(VK_MENU);
  }
  if (vk === undefined) {
    throw new CoreError(
      `key chord "${chord}" has modifiers but no key`,
      "invalid",
    );
  }
  return { vk, modifiers };
}

/** Window handle of a `WindowInfo.id` ("0x000A0B2C"). */
export function parseWindowId(id: string): Deno.PointerValue {
  const hex = id.trim();
  if (!/^0x[0-9a-f]+$/i.test(hex)) {
    throw new CoreError(
      `window id must look like 0x000A0B2C (got "${id}")`,
      "invalid",
    );
  }
  return Deno.UnsafePointer.create(BigInt(hex));
}

/** Render a window handle the way `WindowInfo.id` carries it. */
export function formatWindowId(handle: Deno.PointerValue): string {
  const value = handle === null ? 0n : Deno.UnsafePointer.value(handle);
  return `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- host -------------------------------------------------------------------

/** Open the Win32 libraries, make the process per-monitor DPI aware, and
 * verify a display exists. Any failure is reported as an unavailability
 * reason (the settings toggle shows it verbatim), never as a half-working
 * host. */
export function createWindowsComputerHost(): ComputerHostResult {
  if (Deno.build.arch !== "x86_64" && Deno.build.arch !== "aarch64") {
    return {
      available: false,
      reason:
        `computer use is not supported on this CPU architecture (${Deno.build.arch})`,
    };
  }
  let user32: User32;
  let gdi32: Gdi32;
  let imm32: Imm32;
  try {
    user32 = Deno.dlopen("user32.dll", USER32_SYMBOLS);
    gdi32 = Deno.dlopen("gdi32.dll", GDI32_SYMBOLS);
    imm32 = Deno.dlopen("imm32.dll", IMM32_SYMBOLS);
  } catch (error) {
    return {
      available: false,
      reason: `computer use could not open the Windows libraries: ${
        errorMessage(error)
      }`,
    };
  }
  const closeAll = () => {
    user32.close();
    gdi32.close();
    imm32.close();
  };
  const dpiProblem = ensurePerMonitorAware(user32);
  if (dpiProblem !== undefined) {
    closeAll();
    return { available: false, reason: dpiProblem };
  }
  let displays: DisplayInfo[];
  try {
    displays = enumerateDisplays(user32);
  } catch (error) {
    closeAll();
    return {
      available: false,
      reason: `computer use could not read the display list: ${
        errorMessage(error)
      }`,
    };
  }
  if (displays.length === 0) {
    closeAll();
    return {
      available: false,
      reason: "computer use found no display attached to this machine",
    };
  }
  return {
    available: true,
    host: new WindowsComputerHost(user32, gdi32, imm32),
  };
}

/** Make the process per-monitor DPI aware and verify it took effect. The
 * setter fails when the awareness was already set (a host manifest, another
 * library), so the check — not the return value — is what decides. */
function ensurePerMonitorAware(user32: User32): string | undefined {
  user32.symbols.SetProcessDpiAwarenessContext(
    Deno.UnsafePointer.create(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
  );
  const context = user32.symbols.GetThreadDpiAwarenessContext();
  const awareness = user32.symbols.GetAwarenessFromDpiAwarenessContext(context);
  if (awareness !== DPI_AWARENESS_PER_MONITOR_AWARE) {
    return "computer use needs a per-monitor DPI aware process, and this " +
      `one could not be made aware (DPI awareness ${awareness}); screen ` +
      "coordinates would be wrong";
  }
  return undefined;
}

/** The machine's displays, ordered left to right (then top to bottom) so
 * the indices are stable and follow the physical arrangement. */
function enumerateDisplays(user32: User32): DisplayInfo[] {
  const monitors: Array<{ handle: Deno.PointerValue; bounds: Rect }> = [];
  const callback = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer", "pointer"], result: "i32" },
    (
      monitor: Deno.PointerValue,
      _hdc: Deno.PointerValue,
      rect: Deno.PointerValue,
    ) => {
      try {
        if (rect !== null) {
          const view = new Deno.UnsafePointerView(rect);
          const left = view.getInt32(0);
          const top = view.getInt32(4);
          const right = view.getInt32(8);
          const bottom = view.getInt32(12);
          monitors.push({
            handle: monitor,
            bounds: {
              x: left,
              y: top,
              width: right - left,
              height: bottom - top,
            },
          });
        }
      } catch {
        // A rect we cannot read is not worth aborting the enumeration for;
        // the monitor is simply not offered.
      }
      return 1; // keep enumerating
    },
  );
  try {
    user32.symbols.EnumDisplayMonitors(null, null, callback.pointer, null);
  } finally {
    callback.close();
  }

  const info = new Uint8Array(40);
  const displays: Array<Omit<DisplayInfo, "index">> = [];
  for (const monitor of monitors) {
    new DataView(info.buffer).setUint32(0, 40, true); // cbSize
    if (user32.symbols.GetMonitorInfoW(monitor.handle, info) === 0) {
      throw new CoreError(
        `could not read the monitor info of ${formatWindowId(monitor.handle)}`,
        "unavailable",
      );
    }
    const flags = new DataView(info.buffer).getUint32(36, true);
    displays.push({
      primary: (flags & MONITORINFOF_PRIMARY) !== 0,
      bounds: monitor.bounds,
    });
  }
  displays.sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  return displays.map((display, index) => ({ ...display, index }));
}

class WindowsComputerHost implements ComputerHost {
  private readonly pointerSize: number;
  private closed = false;

  constructor(
    private readonly user32: User32,
    private readonly gdi32: Gdi32,
    private readonly imm32: Imm32,
  ) {
    this.pointerSize = pointerSizeFor(Deno.build.arch);
  }

  describe(): string {
    const displays = this.displays();
    const primary = displays.find((display) => display.primary) ?? displays[0]!;
    const spread = displays.length === 1 ? "" : `, ${displays.length} displays`;
    return `Windows, ${primary.bounds.width}×${primary.bounds.height} primary${spread}`;
  }

  displays(): DisplayInfo[] {
    return enumerateDisplays(this.user32);
  }

  cursor(): Point {
    const buffer = new Uint8Array(8);
    if (this.user32.symbols.GetCursorPos(buffer) === 0) {
      throw new CoreError("could not read the pointer position", "unavailable");
    }
    const view = new DataView(buffer.buffer);
    return { x: view.getInt32(0, true), y: view.getInt32(4, true) };
  }

  capture(region: Rect): Promise<RawCapture> {
    return Promise.resolve(this.grabRegion(region));
  }

  async act(action: ComputerAction): Promise<ComputerActionResult> {
    const started = Date.now();
    switch (action.kind) {
      case "move": {
        const moved = await this.movePointer(action.x, action.y, MOVE_MS);
        return {
          cursor: this.cursor(),
          steps: moved,
          durationMs: Date.now() - started,
        };
      }
      case "click": {
        const steps = await this.movePointer(action.x, action.y, MOVE_MS);
        await sleep(HOVER_SETTLE_MS);
        for (let i = 0; i < action.count; i++) {
          this.sendButton(action.button, true);
          await sleep(CLICK_HOLD_MS);
          this.sendButton(action.button, false);
          if (i + 1 < action.count) await sleep(CLICK_HOLD_MS);
        }
        return {
          cursor: this.cursor(),
          steps,
          durationMs: Date.now() - started,
        };
      }
      case "drag": {
        const approach = await this.movePointer(
          action.from.x,
          action.from.y,
          MOVE_MS,
        );
        await sleep(HOVER_SETTLE_MS);
        this.sendButton(action.button, true);
        await sleep(DRAG_HOLD_MS);
        const path = await this.movePointer(action.to.x, action.to.y, DRAG_MS);
        await sleep(HOVER_SETTLE_MS);
        this.sendButton(action.button, false);
        return {
          cursor: this.cursor(),
          steps: approach + path,
          durationMs: Date.now() - started,
        };
      }
      case "scroll": {
        const steps = await this.movePointer(action.x, action.y, MOVE_MS);
        await sleep(HOVER_SETTLE_MS);
        // One INPUT per wheel event: Windows has no horizontal wheel on all
        // systems, so deltaX rides on the horizontal flag and deltaY on the
        // vertical one.
        if (action.deltaY !== 0) {
          this.sendWheel(MOUSEEVENTF_WHEEL, -action.deltaY * WHEEL_DELTA);
        }
        if (action.deltaX !== 0) {
          this.sendWheel(
            0x01000, /* MOUSEEVENTF_HWHEEL */
            action.deltaX * WHEEL_DELTA,
          );
        }
        return {
          cursor: this.cursor(),
          steps,
          durationMs: Date.now() - started,
        };
      }
      case "type": {
        this.typeText(action.text);
        return {
          cursor: this.cursor(),
          steps: 0,
          durationMs: Date.now() - started,
          window: this.foregroundWindow(),
        };
      }
      case "key": {
        const chord = resolveKeyChord(
          action.key,
          (char) => this.user32.symbols.VkKeyScanW(char.charCodeAt(0)),
        );
        const buffer = buildKeyChordInputs(
          chord.vk,
          chord.modifiers,
          this.pointerSize,
        );
        this.sendInput(buffer, buffer.length / inputSize(this.pointerSize));
        return {
          cursor: this.cursor(),
          steps: 0,
          durationMs: Date.now() - started,
          window: this.foregroundWindow(),
        };
      }
      case "focus_window": {
        const window = await this.focusWindow(action.window);
        return {
          cursor: this.cursor(),
          steps: 0,
          durationMs: Date.now() - started,
          window,
        };
      }
      case "wait": {
        await sleep(action.durationMs);
        return {
          cursor: this.cursor(),
          steps: 0,
          durationMs: Date.now() - started,
        };
      }
    }
  }

  windows(): WindowInfo[] {
    const handles: Deno.PointerValue[] = [];
    const callback = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "i32" },
      (handle: Deno.PointerValue) => {
        try {
          if (handle !== null) handles.push(handle);
        } catch {
          // Skipping an unreadable handle is better than aborting the list.
        }
        return 1; // keep enumerating
      },
    );
    try {
      this.user32.symbols.EnumWindows(callback.pointer, null);
    } finally {
      callback.close();
    }
    const foreground = this.user32.symbols.GetForegroundWindow();
    const windows: WindowInfo[] = [];
    for (const handle of handles) {
      if (this.user32.symbols.IsWindowVisible(handle) === 0) continue;
      const window = this.describeWindow(handle, foreground);
      // Windows without a title are shell plumbing, not something an agent
      // can recognize or aim at.
      if (window.title.length === 0) continue;
      windows.push(window);
    }
    return windows;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.user32.close();
    this.gdi32.close();
    this.imm32.close();
  }

  // --- internals ------------------------------------------------------------

  /** One interpolated pointer movement from where the pointer is now to
   * (x, y). Returns how many move events it took. */
  private async movePointer(
    x: number,
    y: number,
    durationMs: number,
  ): Promise<number> {
    const from = this.cursor();
    const to = { x, y };
    const started = Date.now();
    let steps = 0;
    for (;;) {
      const ratio = durationMs <= 0
        ? 1
        : Math.min(1, (Date.now() - started) / durationMs);
      const at = interpolatePoint(from, to, ratio);
      this.sendMouseMove(at.x, at.y);
      steps++;
      if (ratio >= 1) break;
      await sleep(MOVE_TICK_MS);
    }
    return steps;
  }

  private sendMouseMove(x: number, y: number): void {
    const virtual = this.virtualScreen();
    const buffer = buildMouseInput(
      normalizeAbsolute(x, virtual.x, virtual.width),
      normalizeAbsolute(y, virtual.y, virtual.height),
      MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
      0,
      this.pointerSize,
    );
    this.sendInput(buffer, 1);
  }

  private sendWheel(flags: number, delta: number): void {
    // A wheel event is delivered to the window under the pointer, which is
    // why a scroll always repositions the pointer first.
    const at = this.cursor();
    const virtual = this.virtualScreen();
    const buffer = buildMouseInput(
      normalizeAbsolute(at.x, virtual.x, virtual.width),
      normalizeAbsolute(at.y, virtual.y, virtual.height),
      flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
      delta,
      this.pointerSize,
    );
    this.sendInput(buffer, 1);
  }

  private sendButton(button: MouseButton, down: boolean): void {
    const flags = button === "left"
      ? (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP)
      : button === "right"
      ? (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP)
      : (down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP);
    const at = this.cursor();
    const virtual = this.virtualScreen();
    const buffer = buildMouseInput(
      normalizeAbsolute(at.x, virtual.x, virtual.width),
      normalizeAbsolute(at.y, virtual.y, virtual.height),
      flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
      0,
      this.pointerSize,
    );
    this.sendInput(buffer, 1);
  }

  /** Type one text into the focused control. Newlines become real Enter
   * presses (a Unicode CR/LF is dropped by the controls — measured: "a\r\nb"
   * arrives as "ab"), and the whole run is typed with the IME switched off
   * so an input method cannot eat the characters (see withImeOff). */
  private typeText(text: string): void {
    const segments = splitTypeText(text);
    if (segments.length === 0) return;
    this.withImeOff(() => {
      for (const segment of segments) {
        if (segment.kind === "enter") {
          const buffer = buildKeyChordInputs(VK_RETURN, [], this.pointerSize);
          this.sendInput(
            buffer,
            buffer.length / inputSize(this.pointerSize),
          );
          continue;
        }
        for (let i = 0; i < segment.value.length; i += TYPE_CHUNK_CHARS) {
          const end = Math.min(segment.value.length, i + TYPE_CHUNK_CHARS);
          const units: number[] = [];
          for (let j = i; j < end; j++) {
            units.push(segment.value.charCodeAt(j));
          }
          const buffer = buildUnicodeInputs(units, this.pointerSize);
          this.sendInput(buffer, units.length * 2);
        }
      }
    });
  }

  /**
   * Run `work` with the focused window's IME switched off, restoring its
   * previous state afterwards.
   *
   * An OPEN IME processes keyboard input itself, so injected characters can
   * be consumed by it instead of reaching the control — the documented
   * behaviour for Japanese/Chinese/Korean input methods. Switching the IME
   * off for the duration of the typing (and restoring the user's state in
   * `finally`) is what keeps the text intact; a window without an IME runs
   * the work unchanged, because nothing can intercept it.
   *
   * An IME that is open but cannot be switched off FAILS the call: typing
   * through it would silently corrupt the text, which is worse than a clear
   * error. (This guard does not explain every corruption seen in the field —
   * see the computer-use skill's note on long injected text — but it removes
   * the one cause the host can control.)
   */
  private withImeOff<T>(work: () => T): T {
    const foreground = this.user32.symbols.GetForegroundWindow();
    if (foreground === null) return work();
    const imeWnd = this.imm32.symbols.ImmGetDefaultIMEWnd(foreground);
    if (imeWnd === null) return work(); // no IME attached to this window
    if (!this.imeOpen(imeWnd)) return work();
    this.setImeOpen(imeWnd, false);
    if (this.imeOpen(imeWnd)) {
      throw new CoreError(
        "the focused window has an open IME, which would intercept the " +
          "injected text, and it could not be switched off for typing; " +
          "switch the IME off (半角/全角) and retry",
        "unavailable",
      );
    }
    try {
      return work();
    } finally {
      this.setImeOpen(imeWnd, true);
    }
  }

  /** Whether the IME of `imeWnd` is open (its "on" state). */
  private imeOpen(imeWnd: Deno.PointerValue): boolean {
    return this.imeMessage(imeWnd, IMC_GETOPENSTATUS, 0) !== 0n;
  }

  private setImeOpen(imeWnd: Deno.PointerValue, open: boolean): void {
    this.imeMessage(imeWnd, IMC_SETOPENSTATUS, open ? 1 : 0);
  }

  /** One WM_IME_CONTROL message. Returns 0 when the window did not answer
   * within the timeout: a hung window must not hang the tool. */
  private imeMessage(
    imeWnd: Deno.PointerValue,
    command: number,
    value: number,
  ): bigint {
    const result = new BigUint64Array(1);
    const answered = this.user32.symbols.SendMessageTimeoutW(
      imeWnd,
      WM_IME_CONTROL,
      Deno.UnsafePointer.create(BigInt(command)),
      Deno.UnsafePointer.create(BigInt(value)),
      SMTO_ABORTIFHUNG,
      IME_MESSAGE_TIMEOUT_MS,
      new Uint8Array(result.buffer),
    );
    return answered === null ? 0n : result[0]!;
  }

  private sendInput(buffer: Uint8Array, count: number): void {
    const inserted = this.user32.symbols.SendInput(
      count,
      buffer,
      inputSize(this.pointerSize),
    );
    if (inserted !== count) {
      throw new CoreError(
        `input injection failed: SendInput accepted ${inserted} of ${count} ` +
          "events (an elevated window or another process may be blocking " +
          "synthetic input)",
        "unavailable",
      );
    }
  }

  /** Bring a window to the foreground and verify it actually came forward:
   * Windows refuses the request when the foreground lock is held by another
   * process, and reporting success there would make the agent type into the
   * wrong window. */
  private async focusWindow(id: string): Promise<WindowInfo> {
    const handle = parseWindowId(id);
    if (this.user32.symbols.IsWindow(handle) === 0) {
      throw new CoreError(`no such window: ${id}`, "invalid");
    }
    if (this.user32.symbols.IsIconic(handle) !== 0) {
      this.user32.symbols.ShowWindow(handle, SW_RESTORE);
    }
    this.user32.symbols.SetForegroundWindow(handle);
    await sleep(FOCUS_SETTLE_MS);
    const foreground = this.user32.symbols.GetForegroundWindow();
    if (!Deno.UnsafePointer.equals(foreground, handle)) {
      throw new CoreError(
        `could not bring window ${id} to the foreground (Windows kept ` +
          `${formatWindowId(foreground)} focused)`,
        "unavailable",
      );
    }
    return this.describeWindow(handle, foreground);
  }

  private foregroundWindow(): WindowInfo | undefined {
    const handle = this.user32.symbols.GetForegroundWindow();
    if (handle === null) return undefined;
    return this.describeWindow(handle, handle);
  }

  private describeWindow(
    handle: Deno.PointerValue,
    foreground: Deno.PointerValue,
  ): WindowInfo {
    const title = this.windowTitle(handle);
    const rect = new Uint8Array(16);
    const hasRect = this.user32.symbols.GetWindowRect(handle, rect) !== 0;
    const view = new DataView(rect.buffer);
    const left = hasRect ? view.getInt32(0, true) : 0;
    const top = hasRect ? view.getInt32(4, true) : 0;
    const right = hasRect ? view.getInt32(8, true) : 0;
    const bottom = hasRect ? view.getInt32(12, true) : 0;
    return {
      id: formatWindowId(handle),
      title,
      bounds: {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
      focused: Deno.UnsafePointer.equals(handle, foreground),
      visible: this.user32.symbols.IsWindowVisible(handle) !== 0,
      minimized: this.user32.symbols.IsIconic(handle) !== 0,
    };
  }

  private windowTitle(handle: Deno.PointerValue): string {
    const buffer = new Uint8Array(MAX_WINDOW_TITLE_CHARS * 2);
    const length = this.user32.symbols.GetWindowTextW(
      handle,
      buffer,
      MAX_WINDOW_TITLE_CHARS,
    );
    if (length <= 0) return "";
    return new TextDecoder("utf-16le").decode(buffer.subarray(0, length * 2));
  }

  /** Virtual-desktop bounds in physical pixels: the space SendInput's
   * absolute coordinates are normalized over. Used ONLY for that — every
   * reported coordinate comes from a monitor rect. */
  private virtualScreen(): Rect {
    const metrics = this.user32.symbols.GetSystemMetrics;
    return {
      x: metrics(SM_XVIRTUALSCREEN),
      y: metrics(SM_YVIRTUALSCREEN),
      width: metrics(SM_CXVIRTUALSCREEN),
      height: metrics(SM_CYVIRTUALSCREEN),
    };
  }

  /** Copy a screen region into a BGRA buffer. */
  private grabRegion(region: Rect): RawCapture {
    if (
      region.width < 1 || region.height < 1 ||
      region.width > 16384 || region.height > 16384
    ) {
      throw new CoreError(
        `capture size ${region.width}×${region.height} is out of range (1..16384)`,
        "invalid",
      );
    }
    const screenDC = this.user32.symbols.GetDC(null);
    if (screenDC === null) {
      throw new CoreError(
        "screen capture failed: the screen has no device context",
        "unavailable",
      );
    }
    let memDC: Deno.PointerValue = null;
    let bitmap: Deno.PointerValue = null;
    let previous: Deno.PointerValue = null;
    try {
      memDC = this.gdi32.symbols.CreateCompatibleDC(screenDC);
      if (memDC === null) {
        throw new CoreError(
          "screen capture failed: could not create a memory device context",
          "unavailable",
        );
      }
      bitmap = this.gdi32.symbols.CreateCompatibleBitmap(
        screenDC,
        region.width,
        region.height,
      );
      if (bitmap === null) {
        throw new CoreError(
          "screen capture failed: could not create a bitmap",
          "unavailable",
        );
      }
      previous = this.gdi32.symbols.SelectObject(memDC, bitmap);
      const copied = this.gdi32.symbols.BitBlt(
        memDC,
        0,
        0,
        region.width,
        region.height,
        screenDC,
        region.x,
        region.y,
        SRCCOPY,
      );
      if (copied === 0) {
        throw new CoreError(
          `screen capture failed (BitBlt at ${region.x},${region.y} ` +
            `${region.width}×${region.height})`,
          "unavailable",
        );
      }
      const info = bitmapInfo(region.width, region.height);
      const pixels = new Uint8Array(region.width * region.height * 4);
      const lines = this.gdi32.symbols.GetDIBits(
        memDC,
        bitmap,
        0,
        region.height,
        pixels,
        info,
        0,
      );
      if (lines !== region.height) {
        throw new CoreError(
          `screen capture failed: GetDIBits returned ${lines} of ` +
            `${region.height} scanlines`,
          "unavailable",
        );
      }
      return {
        screen: region,
        pixels,
        width: region.width,
        height: region.height,
      };
    } finally {
      if (memDC !== null && previous !== null) {
        this.gdi32.symbols.SelectObject(memDC, previous);
      }
      if (bitmap !== null) this.gdi32.symbols.DeleteObject(bitmap);
      if (memDC !== null) this.gdi32.symbols.DeleteDC(memDC);
      this.user32.symbols.ReleaseDC(null, screenDC);
    }
  }
}

/** BITMAPINFO for a top-down 32-bit DIB (negative height = top-down, so the
 * rows come back in screen order). */
function bitmapInfo(width: number, height: number): Uint8Array {
  const info = new Uint8Array(44); // BITMAPINFOHEADER + one RGBQUAD
  const view = new DataView(info.buffer);
  view.setUint32(0, 40, true); // biSize
  view.setInt32(4, width, true);
  view.setInt32(8, -height, true);
  view.setUint16(12, 1, true); // biPlanes
  view.setUint16(14, 32, true); // biBitCount
  view.setUint32(16, 0, true); // biCompression: BI_RGB
  return info;
}
