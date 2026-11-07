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
import { screenMove } from "./screen-transition.ts";
import type { UrlState } from "./route.ts";

function at(route: UrlState["route"], settings: UrlState["settings"] = null) {
  return { route, settings } satisfies UrlState;
}

const list = at({ kind: "stella", agentId: null });
const talk = (id: string) => at({ kind: "stella", agentId: id });
const draft = at({ kind: "code", tabKey: null });
const session = (id: string) => at({ kind: "code", tabKey: id });

Deno.test("screen transition: stella's list and a conversation", () => {
  assertEquals(screenMove(list, talk("a1")), "push");
  assertEquals(screenMove(talk("a1"), list), "back");
  // Re-selecting the same one is not a move (the address did not change).
  assertEquals(screenMove(talk("a1"), talk("a1")), null);
});

Deno.test("screen transition: two conversations are lateral", () => {
  // Both are reached from the list, so neither is the screen the reader came
  // from: there is no direction to draw.
  assertEquals(screenMove(talk("a1"), talk("a2")), null);
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
    assertEquals(screenMove(root(kind), page(kind)), "push");
    assertEquals(screenMove(page(kind), root(kind)), "back");
  }
  // Two categories: the same lateral case as two conversations.
  assertEquals(
    screenMove(
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
  assertEquals(screenMove(closed, opened), null);
  assertEquals(screenMove(opened, closed), null);
  // …not even between a conversation and one of its settings pages: the
  // route changed underneath the dialog, which is not a step inside it.
  assertEquals(
    screenMove(list, at({ kind: "stella", agentId: null }, { category: null })),
    null,
  );
  assertEquals(
    screenMove(
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
  assertEquals(screenMove(draft, session("s1")), null);
  assertEquals(screenMove(session("s1"), draft), null);
  assertEquals(screenMove(session("s1"), session("s2")), null);
});

Deno.test("screen transition: the mode chooser is not in either hierarchy", () => {
  const chooser = at({ kind: "modeSelect" });
  assertEquals(
    screenMove(chooser, at({ kind: "stella", agentId: null })),
    null,
  );
  assertEquals(
    screenMove(at({ kind: "stella", agentId: null }), chooser),
    null,
  );
  // Settings do not exist on the chooser (route.ts), so a category cannot be
  // reached from it either.
  assertEquals(screenMove(chooser, at({ kind: "code", tabKey: null })), null);
});
