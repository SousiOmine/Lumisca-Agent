import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  isSettingsCategory,
  ownerGroups,
  ownerLabelKey,
  SETTINGS_CATEGORIES,
  type SettingsNavEntry,
  visibleCategories,
} from "./categories.ts";

/** A minimal entry (the model only needs identity, owner and a label). */
function entry(
  id: SettingsNavEntry["id"],
  owner: SettingsNavEntry["owner"],
  extra: Partial<SettingsNavEntry> = {},
): SettingsNavEntry {
  return { id, owner, labelKey: "common.settings", ...extra };
}

test("ownerGroups groups the entries by where their values live", () => {
  // The device comes first: it is the window the reader is looking through.
  // The order inside a group stays the caller's, because the table is the
  // reading order of the dialog.
  const entries = [
    entry("overview", "server"),
    entry("notifications", "device"),
    entry("providers", "server"),
    entry("app", "device"),
  ];

  assertEquals(
    ownerGroups(entries).map((group) => group.owner),
    ["device", "server"],
  );
  assertEquals(
    ownerGroups(entries).flatMap((group) =>
      group.entries.map((item) => item.id),
    ),
    ["notifications", "app", "overview", "providers"],
  );
});

test("ownerGroups drops an empty owner", () => {
  // A group with no entry gets no heading rather than an empty one.
  const serverOnly = [entry("overview", "server")];
  assertEquals(
    ownerGroups(serverOnly).map((group) => group.owner),
    ["server"],
  );
  assertEquals(ownerGroups([]), []);
});

test("every category is named once, in the table's order", () => {
  // The array is both a type and a value: route.ts accepts exactly these
  // segments, and SettingsModal's table is ordered by it. A duplicate would
  // put one page in the navigation twice; a missing entry would be a page no
  // address could name.
  assertEquals(new Set(SETTINGS_CATEGORIES).size, SETTINGS_CATEGORIES.length);
  assertEquals(
    [...SETTINGS_CATEGORIES],
    [
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
      "prompts",
    ],
  );
});

test("visibleCategories drops a page only the desktop shell serves", () => {
  // The connections page switches this client to another server, which only
  // the shell can do. The rest are shown whatever the client: a missing page
  // hid the page, never its effect. The app page is not one of them any more
  // — it holds the theme, which a browser has too.
  const entries = [
    entry("notifications", "device"),
    entry("connections", "device", { deviceOnly: true }),
    entry("overview", "server"),
  ];

  assertEquals(
    visibleCategories(entries, true, true).map((item) => item.id),
    ["notifications", "connections", "overview"],
  );
  assertEquals(
    visibleCategories(entries, false, true).map((item) => item.id),
    ["notifications", "overview"],
  );
});

test("visibleCategories drops a page code mode alone uses", () => {
  // Saved prompts feed code mode's slash menu: with the mode switched off,
  // the page would list snippets nothing can recall.
  const entries = [
    entry("experimental", "server"),
    entry("prompts", "server", { codeModeOnly: true }),
  ];

  assertEquals(
    visibleCategories(entries, true, true).map((item) => item.id),
    ["experimental", "prompts"],
  );
  assertEquals(
    visibleCategories(entries, true, false).map((item) => item.id),
    ["experimental"],
  );
});

test("ownerLabelKey names the owner", () => {
  assertEquals(ownerLabelKey("device"), "settings.owner.device");
  assertEquals(ownerLabelKey("server"), "settings.owner.server");
});

test("isSettingsCategory accepts the table and refuses anything else", () => {
  // The URL's category segment is checked with this: a name it does not know
  // leaves the dialog open on its first page rather than 404-ing a bookmark.
  for (const id of SETTINGS_CATEGORIES) {
    assertEquals(isSettingsCategory(id), true, id);
  }
  for (const other of [
    "",
    "General",
    "general ",
    "general",
    "servers",
    "nope",
  ]) {
    assertEquals(isSettingsCategory(other), false, other);
  }
});
