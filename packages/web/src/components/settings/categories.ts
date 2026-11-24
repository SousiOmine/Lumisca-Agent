import type { MessageKey } from "@lumisca/core/shared";

/**
 * The settings dialog's navigation model.
 *
 * Every page belongs to one owner: this device, or the server that served the
 * page. The owner is the first level of the navigation because it is the
 * question the dialog could not answer. A value's home is where it is stored,
 * and a page that mixed the two made "my setting" mean two different
 * machines: 一般 held this device's notification toggle, the server's
 * language, and an updater that changed hands with the way the app was
 * launched.
 *
 * The mode is a property of a page (`modeOnly`), not a group. A reader in
 * either mode can find every page, and a page that only acts on code mode's
 * sessions says so with a badge instead of hiding behind a heading.
 *
 * Nothing here belongs to one agent. Routines, names, pictures and models
 * open from the agent's own row in the stella list; a dialog that also
 * changed one agent's machinery made "the app's settings" depend on which
 * conversation happened to be open.
 */

/** Every category of the dialog, in reading order. A category id is part of
 * a URL (route.ts), so the list is a value as well as a type: parsing one
 * back asks whether it names a category, and deriving the union from the
 * array keeps the two from drifting. */
export const SETTINGS_CATEGORIES = [
  "notifications",
  "app",
  "connections",
  "overview",
  "appearance",
  "providers",
  "models",
  "mcp",
  "personalize",
  "prompts",
  "security",
  "experimental",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/** Whether `value` names a category: the question a URL's path segment asks,
 * where the answer may be anything a reader, or a typo, put there. */
export function isSettingsCategory(value: string): value is SettingsCategory {
  return (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

/** Where a page's values are stored, and who decides them.
 *
 * "device" is the window in front of the reader: its notifications, its
 * theme and, in the desktop shell, its app. "server" is the machine that runs
 * the agents: the same values for every conversation it serves.
 */
export type SettingsOwner = "device" | "server";

/** One navigation entry: its identity, its owner, and its label (a catalogue
 * key, so the navigation follows the app language). */
export interface SettingsNavEntry {
  id: SettingsCategory;
  owner: SettingsOwner;
  /** Only code mode's sessions use the values on this page. */
  modeOnly?: boolean;
  /** The page exists only when the desktop shell serves it. */
  deviceOnly?: boolean;
  /** The navigation label. */
  labelKey: MessageKey;
}

/** The entries of one owner. */
export interface SettingsNavGroup<
  T extends SettingsNavEntry = SettingsNavEntry,
> {
  owner: SettingsOwner;
  entries: readonly T[];
}

/**
 * The navigation's groups, in reading order: this device, then the server.
 *
 * A group with no entry is dropped, so a missing owner costs no heading.
 * There is no mode parameter: both modes draw every page (see the module
 * comment). The order inside a group is the caller's; sorting would put 概要
 * somewhere in the middle of the server's pages.
 */
export function ownerGroups<T extends SettingsNavEntry>(
  entries: readonly T[],
): SettingsNavGroup<T>[] {
  const owners: readonly SettingsOwner[] = ["device", "server"];
  return owners
    .map((owner) => ({
      owner,
      entries: entries.filter((entry) => entry.owner === owner),
    }))
    .filter((group) => group.entries.length > 0);
}

/** The label of an owner. The server group draws its own card with the
 * server's name; this label is the page badge and the card's fallback. */
export function ownerLabelKey(owner: SettingsOwner): MessageKey {
  return owner === "device" ? "settings.owner.device" : "settings.owner.server";
}

/**
 * The entries a client can show.
 *
 * Only the desktop shell has an app to update and a bridge that can update
 * it, so the device's app page is absent in a plain browser. Hiding a page
 * for a missing capability is not the same as hiding one mode's pages: the
 * reader can do nothing with a switch whose object does not exist here.
 */
export function visibleCategories<T extends SettingsNavEntry>(
  entries: readonly T[],
  desktop: boolean,
): readonly T[] {
  return entries.filter((entry) => desktop || entry.deviceOnly !== true);
}
