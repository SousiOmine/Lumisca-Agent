import type { AppMode, MessageKey } from "@lumisca/core/shared";

/**
 * The settings dialog's navigation model: which categories exist.
 *
 * The two modes show the same set of pages. They used to be split into two
 * groups (shared, then the current mode's own) with a heading naming each,
 * and nothing on the page told a reader that the other group existed at all:
 * 画面操作 could only be found by switching to code mode first, and ルーチン
 * by switching back. The mode still matters, but only to what a value does —
 * not to which switches the reader may see. A page that acts on one mode's
 * machinery says so itself (ルーチン lists the open agent's conversation,
 * 画面操作 drives this machine, which only code mode's sessions use).
 *
 * The categories also stay apart by subject: one category never held both a
 * mode's own setting and a shared one (the old セキュリティ carried the
 * command check next to computer use, so half of that page did nothing after
 * a mode switch with nothing on screen saying which half).
 *
 * Everything here is data and pure functions: the entries' screens live in
 * SettingsModal (they need the dialog's props), while the table can be
 * reasoned about — and tested — without a DOM.
 */

/** Every category of the dialog, in reading order.
 *
 * The list is a value as well as a type: a category id is part of a URL
 * (route.ts), and parsing one back needs to ask whether it names a category.
 * Deriving the union from the array keeps the two from drifting — a category
 * added to the type but not the array would be unreachable by URL. */
export const SETTINGS_CATEGORIES = [
  "general",
  "appearance",
  "providers",
  "models",
  "mcp",
  "personalize",
  "servers",
  "security",
  "computerUse",
  "prompts",
  "stellaModel",
  "routines",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/** Whether `value` names a category: the question a URL's path segment asks,
 * where the answer may be anything a reader (or a typo) put there. */
export function isSettingsCategory(
  value: string,
): value is SettingsCategory {
  return (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

/** One navigation entry: its identity and its label (a catalogue key, so the
 * navigation follows the app language). */
export interface SettingsNavEntry {
  id: SettingsCategory;
  /** The navigation label. */
  labelKey: MessageKey;
}

/** The catalogue key naming a mode (the dialog's mode chip). */
export function modeLabelKey(mode: AppMode): MessageKey {
  return mode === "code"
    ? "chat.modeSelect.code.title"
    : "chat.modeSelect.stella.title";
}
