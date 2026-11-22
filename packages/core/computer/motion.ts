/**
 * What every computer-use host shares: how a pointer movement is timed, how
 * a key chord is written, and how typed text is split.
 *
 * The timings are constants rather than arguments because a run has to stay
 * reproducible: the agent cannot invent its own timing, and the tool result
 * reports the measured duration so a failure is diagnosable from the
 * transcript. They are also the contract the tool description states
 * ("movement is interpolated over about 0.1s").
 *
 * A key chord is written the same way on every platform ("ctrl+shift+s",
 * "enter", "f5", "+"), but a key IS something different (a Windows virtual
 * key code, an X11 keysym), so only the syntax lives here.
 */
import { CoreError } from "../errors.ts";
import { sleep } from "../shared/misc.ts";
import type {
  ComputerAction,
  ComputerActionResult,
  MouseButton,
  Point,
  WindowInfo,
} from "./types.ts";

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
/** Interval between two interpolation steps. A platform with a coarser
 * timer makes the real step longer; the total still honours the requested
 * duration because the loop is deadline-based. */
export const MOVE_TICK_MS = 10;
/** Stillness after activating a window, before its handle is verified. */
export const FOCUS_SETTLE_MS = 60;

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

/** One piece of a `type` action: literal text, or a real Enter press. A
 * newline cannot ride along as a character — most controls drop a CR/LF code
 * unit (measured on Windows: "a\r\nb" arrives as "ab") — so it becomes an
 * Enter key press, which is also what a person would do. */
export type TypeSegment = { kind: "text"; value: string } | { kind: "enter" };

/** Split typed text into text runs and Enter presses. */
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

/** Modifier names accepted in a key chord. */
export type ModifierName = "ctrl" | "alt" | "shift" | "super";

const MODIFIER_NAMES: Record<string, ModifierName> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  win: "super",
  meta: "super",
  super: "super",
};

/** A key chord split into its parts, before any platform maps them: the
 * modifiers and the key as written. */
export interface ParsedKeyChord {
  modifiers: ModifierName[];
  key: string;
}

/**
 * Parse a chord ("enter", "ctrl+shift+s", "f5", "a", "+") into its modifiers
 * and its key. A single character is the key itself — including "+", which
 * could not be written as a chord because it is the separator. What the key
 * means is the caller's business: a named key or a character to look up.
 */
export function parseKeyChord(chord: string): ParsedKeyChord {
  const trimmed = chord.trim();
  if (trimmed.length === 0) {
    throw new CoreError("key must not be empty", "invalid");
  }
  const parts = trimmed.length === 1 ? [trimmed] : trimmed.split("+");
  const modifiers: ModifierName[] = [];
  let key: string | undefined;
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const modifier = MODIFIER_NAMES[part.toLowerCase()];
    if (modifier !== undefined) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (key !== undefined) {
      throw new CoreError(
        `key chord "${chord}" names more than one key`,
        "invalid",
      );
    }
    key = part;
  }
  if (key === undefined) {
    throw new CoreError(
      `key chord "${chord}" has modifiers but no key`,
      "invalid",
    );
  }
  return { modifiers, key };
}

/**
 * The named keys a chord may spell, in one table shared by every platform.
 *
 * A chord is written the same way everywhere ("enter", "ctrl+shift+s", "f5"),
 * and the SET of names is part of that syntax: a name Windows accepts and
 * X11 refused would be a difference the agent cannot see. What differs is
 * only what a name maps to (a virtual key code, an X11 keysym), so each host
 * carries a table from an id to its own value and nothing else.
 */
export const NAMED_KEY_IDS = [
  "enter",
  "return",
  "tab",
  "escape",
  "esc",
  "space",
  "backspace",
  "delete",
  "del",
  "insert",
  "home",
  "end",
  "pageup",
  "pgup",
  "pagedown",
  "pgdn",
  "up",
  "down",
  "left",
  "right",
  "capslock",
  "numlock",
  "scrolllock",
  "printscreen",
  "pause",
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
] as const;

/** One named key, as a host's table is keyed by it. */
export type NamedKeyId = (typeof NAMED_KEY_IDS)[number];

/** The id of a chord's key part when it names a key, or undefined when it
 * is something else (a single character, or a name no host knows). */
export function namedKeyId(key: string): NamedKeyId | undefined {
  const lower = key.toLowerCase();
  return NAMED_KEY_IDS.find((id) => id === lower);
}

/**
 * What a platform brings to {@link performAction}: the six things that
 * actually differ between hosts. The order of the steps, the settle times and
 * the sign conventions are the same everywhere, so they are written once
 * (below) and a new platform implements only these.
 */
export interface ActionPrimitives {
  /** Move the pointer along a straight line over `durationMs` and report how
   * many move events it took. */
  movePointer(x: number, y: number, durationMs: number): Promise<number>;
  /** Press or release one mouse button where the pointer is. */
  button(button: MouseButton, pressed: boolean): Promise<void>;
  /** One wheel event: `deltaX` rightwards, `deltaY` downwards, both in the
   * tool layer's units (a platform scales them to its own). */
  wheel(deltaX: number, deltaY: number): Promise<void>;
  /** Type one run of text at the focus. */
  typeText(text: string): Promise<void>;
  /** Press one key or chord. */
  key(chord: string): Promise<void>;
  /** Bring a window forward and report it. */
  focusWindow(window: string): Promise<WindowInfo>;
  /** The pointer position, when the platform can report it. */
  cursor(): Point | undefined;
  /** The foreground window, when the platform can report it. */
  foregroundWindow(): WindowInfo | undefined;
}

/**
 * Perform one action: the single implementation of the eight actions, shared
 * by every host.
 *
 * The steps are the contract the tool description states — a movement is
 * interpolated and settled before a press, a drag holds the button across the
 * whole path, a scroll repositions the pointer first (a wheel event goes to
 * the window under it) and a key action reports the window it went to — and
 * they are the same on every platform, so a host that wrote its own copy
 * would be one that could drift. Durations are measured here rather than in
 * the primitives, so `durationMs` always describes the same span.
 *
 * `focus_window` is absent from the primitives: a platform that cannot
 * enumerate windows (Wayland) throws from {@link ActionPrimitives.focusWindow}
 * with its own reason, which is why the case is not optional here.
 */
export async function performAction(
  primitives: ActionPrimitives,
  action: ComputerAction,
): Promise<ComputerActionResult> {
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  switch (action.kind) {
    case "move": {
      const steps = await primitives.movePointer(action.x, action.y, MOVE_MS);
      return { cursor: primitives.cursor(), steps, durationMs: elapsed() };
    }
    case "click": {
      const steps = await primitives.movePointer(action.x, action.y, MOVE_MS);
      await sleep(HOVER_SETTLE_MS);
      for (let i = 0; i < action.count; i++) {
        await primitives.button(action.button, true);
        await sleep(CLICK_HOLD_MS);
        await primitives.button(action.button, false);
        if (i + 1 < action.count) await sleep(CLICK_HOLD_MS);
      }
      return { cursor: primitives.cursor(), steps, durationMs: elapsed() };
    }
    case "drag": {
      const approach = await primitives.movePointer(
        action.from.x,
        action.from.y,
        MOVE_MS,
      );
      await sleep(HOVER_SETTLE_MS);
      await primitives.button(action.button, true);
      await sleep(DRAG_HOLD_MS);
      const path = await primitives.movePointer(
        action.to.x,
        action.to.y,
        DRAG_MS,
      );
      await sleep(HOVER_SETTLE_MS);
      await primitives.button(action.button, false);
      return {
        cursor: primitives.cursor(),
        steps: approach + path,
        durationMs: elapsed(),
      };
    }
    case "scroll": {
      const steps = await primitives.movePointer(action.x, action.y, MOVE_MS);
      await sleep(HOVER_SETTLE_MS);
      if (action.deltaY !== 0 || action.deltaX !== 0) {
        await primitives.wheel(action.deltaX, action.deltaY);
      }
      return { cursor: primitives.cursor(), steps, durationMs: elapsed() };
    }
    case "type": {
      await primitives.typeText(action.text);
      return {
        cursor: primitives.cursor(),
        steps: 0,
        durationMs: elapsed(),
        window: primitives.foregroundWindow(),
      };
    }
    case "key": {
      await primitives.key(action.key);
      return {
        cursor: primitives.cursor(),
        steps: 0,
        durationMs: elapsed(),
        window: primitives.foregroundWindow(),
      };
    }
    case "focus_window": {
      const window = await primitives.focusWindow(action.window);
      return {
        cursor: primitives.cursor(),
        steps: 0,
        durationMs: elapsed(),
        window,
      };
    }
    case "wait": {
      await sleep(action.durationMs);
      return { cursor: primitives.cursor(), steps: 0, durationMs: elapsed() };
    }
  }
}
