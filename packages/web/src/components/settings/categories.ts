import type { AppMode, MessageKey } from "@lumisca/core/shared";

/**
 * The settings dialog's navigation model: which categories exist, and which
 * of them mean anything outside one mode.
 *
 * The categories used to be one flat list in which a category could be
 * hidden on its own (`mode?: AppMode`), and one of them held both kinds at
 * once: セキュリティ carried the command check, which guards every mode, next
 * to computer use, which only exists in code mode — so half of that page did
 * nothing after a mode switch, with nothing on screen saying which half.
 *
 * The scope here is the answer: a category belongs to both modes or to
 * exactly one of them, and the navigation draws the two sets apart. A
 * mode-only category is shown (under the current mode's heading), not hidden,
 * because "this mode has these of its own" is information the reader came
 * for.
 *
 * Everything in this module is data and pure functions: the entries' screens
 * live in SettingsModal (they need the dialog's props), while the grouping
 * rule can be reasoned about — and tested — without a DOM.
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
  "prompts",
  "servers",
  "security",
  "computerUse",
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

/** What a category applies to: both modes, or exactly one of them. */
export type SettingsScope = "common" | AppMode;

/** One navigation entry: its identity, who it applies to, and its label (a
 * catalogue key, so the navigation follows the app language). */
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
 * The navigation's groups for one mode: the shared entries first, then the
 * mode's own. Empty groups are dropped, so a mode with nothing of its own
 * gets no heading rather than an empty one.
 *
 * The order inside a group is the caller's: the table in SettingsModal is the
 * reading order of the dialog, and sorting would put 一般 somewhere in the
 * middle of it.
 */
export function navGroups(
  entries: readonly SettingsNavEntry[],
  mode: AppMode,
): SettingsNavGroup[] {
  const common = entries.filter((entry) => entry.scope === "common");
  const own = entries.filter((entry) => entry.scope === mode);
  return [
    ...(common.length > 0
      ? [{ scope: "common" as const, entries: common }]
      : []),
    ...(own.length > 0 ? [{ scope: mode as SettingsScope, entries: own }] : []),
  ];
}

/** The catalogue key naming a mode (the dialog's mode chip, and the heading
 * of the mode's own group). */
export function modeLabelKey(mode: AppMode): MessageKey {
  return mode === "code"
    ? "chat.modeSelect.code.title"
    : "chat.modeSelect.stella.title";
}
