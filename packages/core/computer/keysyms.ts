/**
 * X11 keysyms: the key values the portal's `NotifyKeyboardKeysym` takes.
 *
 * Injecting a keysym rather than a keycode is what makes typing work
 * without knowing the keyboard layout: mutter resolves the keysym against
 * its own keymap, presses the modifiers that produce it, and remaps a spare
 * keycode for a keysym the layout cannot produce at all. So "A" arrives as
 * an upper-case A without this server having to press Shift itself, and a
 * character outside the layout (Japanese, an emoji) still arrives.
 *
 * The mapping is the standard one: a Latin-1 character is its own keysym,
 * everything else is the Unicode keysym range (0x01000000 + codepoint).
 */
import { CoreError } from "../errors.ts";
import type { ModifierName } from "./motion.ts";

/** Named keys a chord may spell; lower case. */
const NAMED_KEYSYMS: Record<string, number> = {
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  escape: 0xff1b,
  esc: 0xff1b,
  space: 0x0020,
  backspace: 0xff08,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pgup: 0xff55,
  pagedown: 0xff56,
  pgdn: 0xff56,
  up: 0xff52,
  down: 0xff54,
  left: 0xff51,
  right: 0xff53,
  capslock: 0xffe5,
  numlock: 0xff7f,
  scrolllock: 0xff14,
  printscreen: 0xff61,
  pause: 0xff13,
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, 0xffbe + i]),
  ),
};

/** The keysym of the left-hand modifier of each name. Which side matters
 * only to applications that distinguish them, and the left one is what a
 * person presses. */
export const MODIFIER_KEYSYMS: Record<ModifierName, number> = {
  ctrl: 0xffe3, // Control_L
  shift: 0xffe1, // Shift_L
  alt: 0xffe9, // Alt_L
  super: 0xffeb, // Super_L
};

/** The keysym of a newline, i.e. the Enter key: a `type` action turns each
 * newline into one of these (see motion.ts's splitTypeText). */
export const KEYSYM_RETURN = NAMED_KEYSYMS["enter"]!;

/** The keysym of one character (one code point, so a surrogate pair is a
 * single call). */
export function charKeysym(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    throw new CoreError("the character to type is empty", "invalid");
  }
  return codePoint < 0x100 ? codePoint : 0x01000000 + codePoint;
}

/** The keysym of a chord's key part: a named key, or a single character
 * (which is kept as written — "A" is the upper-case keysym). */
export function keyKeysym(key: string): number {
  const named = NAMED_KEYSYMS[key.toLowerCase()];
  if (named !== undefined) return named;
  const characters = [...key];
  if (characters.length !== 1) {
    throw new CoreError(`unknown key "${key}"`, "invalid");
  }
  return charKeysym(characters[0]!);
}
