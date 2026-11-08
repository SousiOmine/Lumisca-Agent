import type { AppMode, MessageKey } from "@lumisca/core/shared";

/**
 * The settings dialog's navigation model: which categories exist, and what
 * each one's values act on.
 *
 * Both modes show every category: hiding a page hid the page, never the
 * effect, and a reader in stella mode could not learn that 画面操作 existed
 * without switching modes first. What a reader does need to see is which
 * pages change something in this mode — a routine only exists in a stella
 * conversation, computer use only drives this machine for code mode's
 * sessions — so the navigation groups the entries by that and names each
 * group. The grouping is the same in both modes; only the group a reader is
 * working in differs.
 *
 * The categories also stay apart by subject: one page never held both a
 * mode's own setting and a shared one (the old セキュリティ carried the
 * command check next to computer use, so half of that page did nothing after
 * a mode switch with nothing on screen saying which half).
 *
 * Everything here is data and pure functions: the entries' screens live in
 * SettingsModal (they need the dialog's props), while the grouping can be
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

/** What a category's values act on: both modes, or exactly one of them. */
export type SettingsScope = "common" | AppMode;

/** One navigation entry: its identity, what its values act on, and its label
 * (a catalogue key, so the navigation follows the app language). */
export interface SettingsNavEntry {
  id: SettingsCategory;
  scope: SettingsScope;
  /** The navigation label. */
  labelKey: MessageKey;
}

/** The entries of one group of the navigation. */
export interface SettingsNavGroup {
  scope: SettingsScope;
  entries: readonly SettingsNavEntry[];
}

/**
 * The navigation's groups, in reading order: what both modes share, then
 * code mode's own, then stella's. A group with no entry is dropped, so a
 * missing one costs no heading.
 *
 * There is no mode parameter: both modes draw every group (see the module
 * comment). The order inside a group is the caller's — the table in
 * SettingsModal is the reading order of the dialog, and sorting would put
 * 一般 somewhere in the middle of it.
 */
export function navGroups(
  entries: readonly SettingsNavEntry[],
): SettingsNavGroup[] {
  const scopes: readonly SettingsScope[] = ["common", "code", "stella"];
  return scopes
    .map((scope) => ({
      scope,
      entries: entries.filter((entry) => entry.scope === scope),
    }))
    .filter((group) => group.entries.length > 0);
}

/** The catalogue key naming a mode (the heading of that mode's group). */
export function modeLabelKey(mode: AppMode): MessageKey {
  return mode === "code"
    ? "chat.modeSelect.code.title"
    : "chat.modeSelect.stella.title";
}
