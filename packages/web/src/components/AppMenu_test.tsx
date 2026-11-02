/**
 * The hamburger menu's entries per mode.
 *
 * stella mode has one conversation per agent and no tab strip, so "new tab"
 * and "session history" there could only open code mode's machinery inside a
 * conversation view — controls that cannot do what they say. Code mode keeps
 * them; everything that belongs to the app (mode switch, settings, quit) is
 * in both.
 */
import { assertEquals } from "@std/assert";
import { menuEntries } from "./AppMenu.tsx";

Deno.test("AppMenu: code mode offers the tab actions", () => {
  assertEquals(menuEntries({ tabs: true, isDesktop: false }), [
    { kind: "newTab" },
    { kind: "history" },
    { kind: "separator" },
    { kind: "switchMode" },
    { kind: "settings" },
  ]);
});

Deno.test("AppMenu: stella mode drops the tab actions", () => {
  // Regression: the same menu was drawn in stella mode, so "new tab" opened
  // code mode's empty draft from inside a conversation.
  assertEquals(menuEntries({ tabs: false, isDesktop: false }), [
    { kind: "switchMode" },
    { kind: "settings" },
  ]);
  // The desktop-only quit entry is not resurrected by dropping the tabs.
  assertEquals(menuEntries({ tabs: false, isDesktop: true }), [
    { kind: "switchMode" },
    { kind: "settings" },
    { kind: "separator" },
    { kind: "quit" },
  ]);
});

Deno.test("AppMenu: the desktop menu keeps quit in code mode", () => {
  assertEquals(menuEntries({ tabs: true, isDesktop: true }), [
    { kind: "newTab" },
    { kind: "history" },
    { kind: "separator" },
    { kind: "switchMode" },
    { kind: "settings" },
    { kind: "separator" },
    { kind: "quit" },
  ]);
});
