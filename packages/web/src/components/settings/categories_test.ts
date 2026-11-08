import { assertEquals } from "@std/assert";
import {
  isSettingsCategory,
  modeLabelKey,
  SETTINGS_CATEGORIES,
} from "./categories.ts";

Deno.test("every category is named once, in reading order", () => {
  // The array is both a type and a value: route.ts accepts exactly these
  // segments, and SettingsModal draws its table in this order. A duplicate
  // would put one page in the navigation twice; a missing entry would be a
  // page no address could name.
  assertEquals(new Set(SETTINGS_CATEGORIES).size, SETTINGS_CATEGORIES.length);
  // No category is hidden from a mode: the list is the same in both, so it is
  // pinned here rather than derived (a mode-scoped split is what this replaced).
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
    "stellaModel",
    "routines",
  ]);
});

Deno.test("modeLabelKey names the mode the dialog describes", () => {
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
