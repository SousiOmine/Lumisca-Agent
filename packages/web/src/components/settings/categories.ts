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

/** Every category of the dialog. */
export type SettingsCategory =
  | "general"
  | "appearance"
  | "providers"
  | "models"
  | "mcp"
  | "personalize"
  | "prompts"
  | "servers"
  | "security"
  | "computerUse"
  | "routines";

/**
 * The categories both modes have. Only these may be opened from outside
 * (`initialCategory`), because the dialog cannot honour a page the current
 * mode does not have: typing the prop this way makes that a compile error
 * instead of a blank page.
 */
export type CommonSettingsCategory =
  | "general"
  | "appearance"
  | "providers"
  | "models"
  | "mcp"
  | "personalize"
  | "servers"
  | "security";

/** What a category applies to: both modes, or exactly one of them. */
export type SettingsScope = "common" | AppMode;

/** One navigation entry: its identity, who it applies to, and its labels
 * (catalogue keys, so the navigation follows the app language). */
export interface SettingsNavEntry {
  id: SettingsCategory;
  scope: SettingsScope;
  /** The navigation label. */
  labelKey: MessageKey;
  /** One line saying what the category decides. The page prints it under
   * its title, and the stepped (phone) index prints it under the label. */
  descriptionKey: MessageKey;
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
