/**
 * The hamburger menu's entries per mode.
 *
 * stella mode has one conversation per agent and no tab strip, so "new tab"
 * and "session history" there could only open code mode's machinery inside a
 * conversation view — controls that cannot do what they say. Code mode keeps
 * them; everything that belongs to the app (the switch, settings, quit) is in
 * both. The switch names the mode it leads to, so one press is the whole
 * interaction.
 */
import { assertEquals } from "@std/assert";
import { menuEntries } from "./AppMenu.tsx";

Deno.test("AppMenu: code mode offers the tab actions", () => {
  assertEquals(menuEntries({ mode: "code", isDesktop: false }), [
    { kind: "newTab" },
    { kind: "history" },
    { kind: "separator" },
    { kind: "switchMode", to: "stella" },
    { kind: "settings" },
  ]);
});

Deno.test("AppMenu: stella mode drops the tab actions", () => {
  // Regression: the same menu was drawn in stella mode, so "new tab" opened
  // code mode's empty draft from inside a conversation.
  assertEquals(menuEntries({ mode: "stella", isDesktop: false }), [
    { kind: "switchMode", to: "code" },
    { kind: "settings" },
  ]);
  // The desktop-only quit entry is not resurrected by dropping the tabs.
  assertEquals(menuEntries({ mode: "stella", isDesktop: true }), [
    { kind: "switchMode", to: "code" },
    { kind: "settings" },
    { kind: "separator" },
    { kind: "quit" },
  ]);
});

Deno.test("AppMenu: the desktop menu keeps quit in code mode", () => {
  assertEquals(menuEntries({ mode: "code", isDesktop: true }), [
    { kind: "newTab" },
    { kind: "history" },
    { kind: "separator" },
    { kind: "switchMode", to: "stella" },
    { kind: "settings" },
    { kind: "separator" },
    { kind: "quit" },
  ]);
});

Deno.test("AppMenu: the switch never names the mode the reader is in", () => {
  // The menu used to open a chooser, where "in use" marked the current card.
  // Now the entry itself is the whole choice: offering the current mode would
  // be an entry that does nothing.
  for (const mode of ["code", "stella"] as const) {
    const [entry] = menuEntries({ mode, isDesktop: false }).filter(
      (candidate) => candidate.kind === "switchMode",
    );
    assertEquals(entry, {
      kind: "switchMode",
      to: mode === "code" ? "stella" : "code",
    });
  }
});
