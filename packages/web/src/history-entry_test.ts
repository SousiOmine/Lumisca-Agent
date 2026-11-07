/**
 * The shape `history` keeps behind the address.
 *
 * The case that matters is closing the settings dialog: it is drawn over the
 * screen it was opened from, but every category picked inside it adds an
 * entry. One step back would stop on a page of the dialog whose exit has
 * already run — the sheet is invisible and its backdrop still covers the app.
 * These tests fix the depth each entry records and the number of steps a close
 * takes.
 */
import { assertEquals } from "@std/assert";
import {
  APP_ENTRY,
  DIALOG_DEPTH,
  dialogDepth,
  dismissSteps,
  isAppEntry,
  pushedState,
  replacedState,
} from "./history-entry.ts";
import type { UrlState } from "./route.ts";

/** A code-mode screen, with or without the settings dialog over it. */
function code(settings: UrlState["settings"]): UrlState {
  return { route: { kind: "code", tabKey: null }, settings };
}

const closed = code(null);
const list = code({ category: null });
const general = code({ category: "general" });
const appearance = code({ category: "appearance" });

Deno.test("history entry: a push is the app's and records how deep the dialog is", () => {
  // Opened over a screen with no dialog: the dialog's first entry.
  const opened = pushedState(null, list);
  assertEquals(opened[APP_ENTRY], true);
  assertEquals(dialogDepth(opened), 1);
  assertEquals(isAppEntry(opened), true);

  // A category picked from it sits one entry higher, and so on.
  const page = pushedState(opened, general);
  assertEquals(dialogDepth(page), 2);
  assertEquals(dialogDepth(pushedState(page, appearance)), 3);

  // A screen with no dialog over it starts the count again, whatever the
  // entry it was pushed from named.
  const left = pushedState(page, closed);
  assertEquals(dialogDepth(left), 0);
  assertEquals(dialogDepth(pushedState(left, list)), 1);
});

Deno.test("history entry: a known state never passes for the app's", () => {
  // `history.state` is whatever the page put there, and the app has run on
  // origins it does not control: only its own marker may unlock `back()`.
  for (const state of [null, undefined, 0, "lumisca", {}, { lumisca: false }]) {
    assertEquals(isAppEntry(state), false, JSON.stringify(state));
    assertEquals(dialogDepth(state), 0, JSON.stringify(state));
  }
});

Deno.test("history entry: a depth that is not a positive integer is none", () => {
  // Walking back an unknown number of entries would skip the screen the
  // dialog covered; one step is wrong too, so the caller has to stop
  // believing the value and fall back to a single move.
  for (const depth of [0, -2, 1.5, Number.NaN, "2", null, {}]) {
    assertEquals(
      dialogDepth({ [APP_ENTRY]: true, [DIALOG_DEPTH]: depth }),
      0,
      String(depth),
    );
  }
});

Deno.test("history entry: closing the dialog walks back over all its pages", () => {
  // Opened, three categories picked, then closed: four entries to undo.
  assertEquals(dismissSteps(4, closed), 4);
  // Opened and closed: one.
  assertEquals(dismissSteps(1, closed), 1);
  // An entry with no depth recorded still closes in one move: a missing
  // count must not become "stay where you are".
  assertEquals(dismissSteps(0, closed), 1);
  // A step inside the dialog (back to the list) is one entry.
  assertEquals(dismissSteps(3, list), 1);
  // A screen with no dialog over it (stella's list) is one entry.
  assertEquals(
    dismissSteps(0, {
      route: { kind: "stella", agentId: null },
      settings: null,
    }),
    1,
  );
});

Deno.test("history entry: a replace drops a depth the new address does not name", () => {
  const page = pushedState(pushedState(null, list), general);
  // The session the dialog covered was deleted: its fallback replaces the
  // entry with a screen that has no dialog. Keeping depth 2 would make the
  // next close skip two screens that have nothing to do with it.
  const replaced = replacedState(page, closed);
  assertEquals(dialogDepth(replaced), 0);
  assertEquals(isAppEntry(replaced), true);
  assertEquals(dialogDepth(pushedState(replaced, list)), 1);
});

Deno.test("history entry: a replace keeps an entry the app did not push unknown", () => {
  // A page loaded from a link stays the page that was loaded: writing the
  // app's marker would claim a screen behind it.
  assertEquals(replacedState(null, closed), null);
  assertEquals(replacedState({ other: 1 }, closed), { other: 1 });
});
