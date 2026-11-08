import { assertEquals } from "@std/assert";
import {
  isSettingsCategory,
  modeLabelKey,
  navGroups,
  SETTINGS_CATEGORIES,
  type SettingsNavEntry,
} from "./categories.ts";

/** A minimal entry (the model only needs identity, scope and a label). */
function entry(
  id: SettingsNavEntry["id"],
  scope: SettingsNavEntry["scope"],
): SettingsNavEntry {
  return { id, scope, labelKey: "common.settings" };
}

Deno.test("navGroups groups the entries by what they act on", () => {
  // Both modes draw every group, so the groups are the effect, not the mode
  // on screen: shared first, then code mode's own, then stella's.
  const entries = [
    entry("general", "common"),
    entry("routines", "stella"),
    entry("appearance", "common"),
    entry("computerUse", "code"),
  ];

  assertEquals(navGroups(entries).map((group) => group.scope), [
    "common",
    "code",
    "stella",
  ]);
  assertEquals(
    navGroups(entries).flatMap((group) => group.entries.map((item) => item.id)),
    ["general", "appearance", "computerUse", "routines"],
  );
});

Deno.test("navGroups keeps the caller's order inside a group", () => {
  // Reading order is the table's, not the alphabet's: sorting would put 一般
  // somewhere in the middle of the shared group.
  const entries = [
    entry("general", "common"),
    entry("appearance", "common"),
    entry("providers", "common"),
  ];
  assertEquals(
    navGroups(entries)[0]!.entries.map((item) => item.id),
    ["general", "appearance", "providers"],
  );
});

Deno.test("navGroups drops an empty group", () => {
  // A group with no entry gets no heading rather than an empty one.
  const shared = [entry("general", "common")];
  assertEquals(navGroups(shared).map((group) => group.scope), ["common"]);
  assertEquals(navGroups([]), []);
});

Deno.test("every category is named once, in the table's order", () => {
  // The array is both a type and a value: route.ts accepts exactly these
  // segments, and SettingsModal's table is ordered by it. A duplicate would
  // put one page in the navigation twice; a missing entry would be a page no
  // address could name.
  assertEquals(new Set(SETTINGS_CATEGORIES).size, SETTINGS_CATEGORIES.length);
  assertEquals([...SETTINGS_CATEGORIES], [
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
    "routines",
  ]);
});

Deno.test("modeLabelKey names the mode a group acts on", () => {
  assertEquals(modeLabelKey("code"), "chat.modeSelect.code.title");
  assertEquals(modeLabelKey("stella"), "chat.modeSelect.stella.title");
});

Deno.test("isSettingsCategory accepts the table and refuses anything else", () => {
  // The URL's category segment is checked with this: a name it does not know
  // leaves the dialog open on its first page rather than 404-ing a bookmark.
  for (const id of SETTINGS_CATEGORIES) {
    assertEquals(isSettingsCategory(id), true, id);
  }
  for (const other of ["", "General", "general ", "Providers", "nope"]) {
    assertEquals(isSettingsCategory(other), false, other);
  }
});
