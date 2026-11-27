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
 * Both modes draw the same pages, with one exception: a page whose values
 * only code mode uses exists only while code mode is offered
 * (`codeModeOnly`). Hidden with the feature it belongs to, it cannot be read
 * as a setting that does nothing.
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
  "app",
  "notifications",
  "connections",
  "overview",
  "providers",
  "models",
  "mcp",
  "personalize",
  "security",
  "experimental",
  "screen",
  "prompts",
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
  /** The page exists only when the desktop shell serves it. */
  deviceOnly?: boolean;
  /** The page exists only while code mode is offered (see 実験的機能). */
  codeModeOnly?: boolean;
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
 * The order inside a group is the caller's; sorting would put 概要 somewhere
 * in the middle of the server's pages.
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
 * Two pages are conditional, for two different reasons. The connections page
 * needs the desktop shell: only it can switch this client to another server,
 * and a browser would be offered a control it cannot carry out. A page marked
 * `codeModeOnly` needs code mode to be offered at all: its values act on a
 * mode the app does not have while the switch is off, so the page would be a
 * list of settings nothing reads.
 */
export function visibleCategories<T extends SettingsNavEntry>(
  entries: readonly T[],
  desktop: boolean,
  codeMode: boolean,
): readonly T[] {
  return entries.filter(
    (entry) =>
      (desktop || entry.deviceOnly !== true) &&
      (codeMode || entry.codeModeOnly !== true),
  );
}
