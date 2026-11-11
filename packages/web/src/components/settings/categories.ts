import type { MessageKey } from "@lumisca/core/shared";

/**
 * The settings dialog's navigation model: which categories exist, and what
 * each one's values act on.
 *
 * Everything the dialog holds is a setting of this installation — the same
 * for every conversation and for every agent. Something that belongs to ONE
 * agent is not a category here: routines are that agent's, so they open from
 * the agent's own row in the stella list (StellaSidebar), and an agent's name,
 * picture and model open from the same menu's editor. A settings dialog that
 * also changed one agent's machinery made "the app's settings" two different
 * things depending on which conversation happened to be open.
 *
 * Both modes show every category: hiding a page hid the page, never the
 * effect, and a reader in stella mode could not learn that 画面操作 existed
 * without switching modes first. What a reader does need to see is which
 * pages act on which mode's sessions — computer use drives this machine for
 * code mode's sessions, a saved prompt is recalled by code mode's composer —
 * so the navigation groups the entries by that and names each group.
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
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/** Whether `value` names a category: the question a URL's path segment asks,
 * where the answer may be anything a reader (or a typo) put there. */
export function isSettingsCategory(value: string): value is SettingsCategory {
  return (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

/** What a category's values act on: the whole app, or exactly one mode's
 * sessions. Nothing here acts on one agent — that is not this dialog's
 * subject (see the module comment). */
export type SettingsScope = "common" | "code";

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
 * The navigation's groups, in reading order: what the whole app shares, then
 * what only code mode's sessions use. A group with no entry is dropped, so a
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
  const scopes: readonly SettingsScope[] = ["common", "code"];
  return scopes
    .map((scope) => ({
      scope,
      entries: entries.filter((entry) => entry.scope === scope),
    }))
    .filter((group) => group.entries.length > 0);
}

/** The catalogue key heading a group: the shared one, or the mode whose
 * sessions the group's pages act on. */
export function scopeLabelKey(scope: SettingsScope): MessageKey {
  return scope === "common"
    ? "settings.nav.common"
    : "chat.modeSelect.code.title";
}
