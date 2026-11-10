/**
 * The screen-transition rule.
 *
 * Which address pairs animate is a product decision (a hierarchy the reader
 * walks into, not every move), and getting it wrong is invisible in a
 * stylesheet: a missed case simply does not slide, and an extra case claims a
 * hierarchy the app does not have. The check runs over the real addresses the
 * App builds, so a new screen has to say whether it belongs to one.
 */
import { assertEquals } from "@std/assert";
import { type ScreenLayout, screenMove } from "./screen-transition.ts";
import type { UrlState } from "./route.ts";

function at(route: UrlState["route"], settings: UrlState["settings"] = null) {
  return { route, settings } satisfies UrlState;
}

/** One screen at a time: a phone, or a tablet held upright. */
const oneScreen: ScreenLayout = { singleScreen: true };
/** Two columns: a wide window, where stella's list sits beside a conversation. */
const columns: ScreenLayout = { singleScreen: false };

/** Most cases are about which addresses move, not about the window, so the
 * layout where stella's two surfaces are exclusive is the default. */
function move(
  previous: UrlState,
  next: UrlState,
  layout: ScreenLayout = oneScreen,
) {
  return screenMove(previous, next, layout);
}

const list = at({ kind: "stella", agentId: null });
const talk = (id: string) => at({ kind: "stella", agentId: id });
const draft = at({ kind: "code", tabKey: null });
const session = (id: string) => at({ kind: "code", tabKey: id });

Deno.test("screen transition: stella's list and a conversation", () => {
  assertEquals(move(list, talk("a1")), "push");
  assertEquals(move(talk("a1"), list), "back");
  // Re-selecting the same one is not a move (the address did not change).
  assertEquals(move(talk("a1"), talk("a1")), null);
});

Deno.test("screen transition: two conversations are lateral", () => {
  // Both are reached from the list, so neither is the screen the reader came
  // from: there is no direction to draw.
  assertEquals(move(talk("a1"), talk("a2")), null);
});

Deno.test("screen transition: two columns are not two screens", () => {
  // A wide window shows both surfaces at once, and the layout moves them
  // itself when the address names an agent: the list travels to the left
  // margin and the conversation arrives from the right (stella.css). A
  // page-wide snapshot there would capture the list twice — once centred, once
  // moved — and cross-fade it over itself, so there is no transition to play.
  assertEquals(move(list, talk("a1"), columns), null);
  assertEquals(move(talk("a1"), list, columns), null);

  // The settings dialog is not affected: its category list stays where it is
  // beside the page, and the page is inside a dialog whose surface changes, so
  // the cross-fade is still the right answer at any width.
  const root = at({ kind: "stella", agentId: null }, { category: null });
  const page = at({ kind: "stella", agentId: null }, { category: "general" });
  assertEquals(move(root, page, columns), "push");
  assertEquals(move(page, root, columns), "back");
});

Deno.test("screen transition: settings' list and a category", () => {
  const root = (kind: UrlState["route"]["kind"]) =>
    kind === "stella"
      ? at({ kind: "stella", agentId: null }, { category: null })
      : at({ kind: "code", tabKey: null }, { category: null });
  const page = (kind: UrlState["route"]["kind"]) =>
    kind === "stella"
      ? at({ kind: "stella", agentId: null }, { category: "general" })
      : at({ kind: "code", tabKey: null }, { category: "appearance" });

  for (const kind of ["code", "stella"] as const) {
    assertEquals(move(root(kind), page(kind)), "push");
    assertEquals(move(page(kind), root(kind)), "back");
  }
  // Two categories: the same lateral case as two conversations.
  assertEquals(
    move(
      at({ kind: "code", tabKey: null }, { category: "general" }),
      at({ kind: "code", tabKey: null }, { category: "appearance" }),
    ),
    null,
  );
});

Deno.test("screen transition: opening and closing the dialog is not a move", () => {
  // The dialog has its own entrance and exit (Modal.tsx). Its first page
  // arrives with the sheet, not after it.
  const closed = at({ kind: "code", tabKey: null });
  const opened = at({ kind: "code", tabKey: null }, { category: null });
  assertEquals(move(closed, opened), null);
  assertEquals(move(opened, closed), null);
  // …not even between a conversation and one of its settings pages: the
  // route changed underneath the dialog, which is not a step inside it.
  assertEquals(
    move(list, at({ kind: "stella", agentId: null }, { category: null })),
    null,
  );
  assertEquals(
    move(
      talk("a1"),
      at({ kind: "stella", agentId: null }, { category: "general" }),
    ),
    null,
  );
});

Deno.test("screen transition: code mode's moves stay instant", () => {
  // A tab switch is lateral (the tab bar is a list of peers), and a session
  // is not deeper than the draft screen: the draft is a place the reader is
  // finished with, and closing a session returns to it.
  assertEquals(move(draft, session("s1")), null);
  assertEquals(move(session("s1"), draft), null);
  assertEquals(move(session("s1"), session("s2")), null);
});

Deno.test("screen transition: the mode chooser is not in either hierarchy", () => {
  const chooser = at({ kind: "modeSelect" });
  assertEquals(
    move(chooser, at({ kind: "stella", agentId: null })),
    null,
  );
  assertEquals(
    move(at({ kind: "stella", agentId: null }), chooser),
    null,
  );
  // Settings do not exist on the chooser (route.ts), so a category cannot be
  // reached from it either.
  assertEquals(move(chooser, at({ kind: "code", tabKey: null })), null);
});
