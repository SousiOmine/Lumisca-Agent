import { assertEquals } from "@std/assert";
import type { AppMode } from "@lumisca/core/shared";
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
  return {
    id,
    scope,
    labelKey: "common.settings",
  };
}

const MODES: AppMode[] = ["code", "stella"];

Deno.test("navGroups puts the shared entries first, then the mode's own", () => {
  const entries = [
    entry("general", "common"),
    entry("routines", "stella"),
    entry("appearance", "common"),
    entry("computerUse", "code"),
  ];

  assertEquals(navGroups(entries, "code").map((group) => group.scope), [
    "common",
    "code",
  ]);
  assertEquals(
    navGroups(entries, "code").flatMap((group) =>
      group.entries.map((item) => item.id)
    ),
    ["general", "appearance", "computerUse"],
  );
  assertEquals(
    navGroups(entries, "stella").flatMap((group) =>
      group.entries.map((item) => item.id)
    ),
    ["general", "appearance", "routines"],
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
    navGroups(entries, "code")[0]!.entries.map((item) => item.id),
    ["general", "appearance", "providers"],
  );
});

Deno.test("navGroups drops an empty group", () => {
  // A mode with nothing of its own gets no heading rather than an empty one.
  const shared = [entry("general", "common")];
  assertEquals(navGroups(shared, "code").map((group) => group.scope), [
    "common",
  ]);
  assertEquals(navGroups([], "code"), []);
});

Deno.test("a mode-only category is listed under that mode alone", () => {
  const entries = [entry("prompts", "code"), entry("routines", "stella")];
  const inCode = navGroups(entries, "code");
  assertEquals(inCode.flatMap((group) => group.entries.map((i) => i.id)), [
    "prompts",
  ]);
  assertEquals(inCode[0]!.scope, "code");
  const inStella = navGroups(entries, "stella");
  assertEquals(inStella.flatMap((group) => group.entries.map((i) => i.id)), [
    "routines",
  ]);
  assertEquals(inStella[0]!.scope, "stella");
});

Deno.test("modeLabelKey names the mode the dialog describes", () => {
  assertEquals(modeLabelKey("code"), "chat.modeSelect.code.title");
  assertEquals(modeLabelKey("stella"), "chat.modeSelect.stella.title");
});

Deno.test("navGroups lists every shared category in both modes", () => {
  // The scopes decide which categories a mode shows: the common ones appear
  // in both, and a mode's own appear in that one only. The URL parser relies
  // on the same table (route.ts accepts exactly these segments), so a
  // category that is missing here would be a page no address could name.
  const shared = SETTINGS_CATEGORIES.filter((id) =>
    id === "general" || id === "appearance" || id === "providers" ||
    id === "models" || id === "mcp" || id === "personalize" ||
    id === "servers" || id === "security"
  );
  const entries = shared.map((id) => entry(id, "common"));
  for (const mode of MODES) {
    assertEquals(
      navGroups(entries, mode).flatMap((group) =>
        group.entries.map((item) => item.id)
      ),
      shared,
      `shared categories must be listed in ${mode}`,
    );
  }
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
