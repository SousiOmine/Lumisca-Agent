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
import type { Point } from "./types.ts";

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
