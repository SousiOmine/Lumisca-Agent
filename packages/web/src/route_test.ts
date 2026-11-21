/**
 * The URL ⇄ screen rule.
 *
 * The cases that matter are the ones a reader actually produces: a bookmark
 * of one session, a link to another server's session, a settings page, and
 * the leftovers — a typo, a category that was removed, an escape that is not
 * one. Every one of those has to land on a screen the reader can use, because
 * this app has no "not found" page to send them to.
 */
import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { SETTINGS_CATEGORIES } from "./components/settings/categories.ts";
import { availableRoute, parseUrl, type UrlState, urlOf } from "./route.ts";
import { tabKey } from "./tabs.ts";

/** A state with the settings dialog closed. */
function at(route: UrlState["route"]): UrlState {
  return { route, settings: null };
}

/** An open settings dialog on one category. */
function withSettings(
  route: UrlState["route"],
  category: UrlState["settings"] extends null
    ? never
    : NonNullable<UrlState["settings"]>["category"],
): UrlState {
  return { route, settings: { category } };
}

/** Every address round-trips through its own parser. */
function roundTrip(state: UrlState): void {
  assertEquals(parseUrl(urlOf(state)), state);
}

test("route: a mode's top is one segment", () => {
  for (const [route, path] of [
    [{ kind: "code", tabKey: null }, "/code"],
    [{ kind: "stella", agentId: null }, "/agents"],
  ] as const) {
    assertEquals(urlOf(at(route)), path);
    roundTrip(at(route));
  }
});

test("route: a local session carries its id", () => {
  const state = at({ kind: "code", tabKey: "s-1" });
  assertEquals(urlOf(state), "/code/s/s-1");
  roundTrip(state);
});

test("route: a peer's session names the peer", () => {
  // The peer id is a path segment, not part of the session id: a reader
  // copying the address of a remote session gets a link this hub can resolve
  // without guessing which half is which.
  const state = at({ kind: "code", tabKey: tabKey("peer-1", "s-1") });
  assertEquals(urlOf(state), "/code/p/peer-1/s/s-1");
  roundTrip(state);
});

test("route: a peer id with the tab key's separator survives", () => {
  // Connection ids come from the registry the user edits, so `:` and `%` are
  // legal in them. The tab key escapes both (tabs.ts); the URL must not undo
  // that escaping when it splits the key back apart.
  const key = tabKey("peer:with%odd", "s-1");
  const state = at({ kind: "code", tabKey: key });
  roundTrip(state);
});

test("route: code mode's addresses are stella's top while it is off", () => {
  // Code mode is an experimental switch (settings → 実験的機能), off by
  // default. The gate has to apply to what the app DRAWS, not only to the
  // address it replaces afterwards: opening the session named by a bookmarked
  // `/code/s/<id>` on the way to the redirect would be an access.
  for (const path of ["/code", "/code/s/s-1", "/code/p/peer-1/s/s-1"]) {
    const { route } = parseUrl(path);
    assertEquals(availableRoute(route, false), {
      kind: "stella",
      agentId: null,
    });
    assertEquals(availableRoute(route, true), route);
  }
  // Everything else is unaffected by the switch.
  const stella = parseUrl("/agents/a-1").route;
  assertEquals(availableRoute(stella, false), stella);
  assertEquals(availableRoute({ kind: "start" }, false), { kind: "start" });
});

test("route: a session id is not split into a peer", () => {
  // `/code/s/a:b` names a session whose id contains a colon: the id half of a
  // key is never escaped, so a path must not be able to turn that into peer
  // `a`'s session `b`.
  assertEquals(
    parseUrl("/code/s/a:b"),
    at({ kind: "code", tabKey: tabKey("", "a:b") }),
  );
});

test("route: an encoded id decodes once", () => {
  const state = at({ kind: "code", tabKey: "a/b" });
  assertEquals(urlOf(state), "/code/s/a%2Fb");
  roundTrip(state);
});

test("route: a conversation carries its agent", () => {
  const state = at({ kind: "stella", agentId: "a-1" });
  assertEquals(urlOf(state), "/agents/a-1");
  roundTrip(state);
});

test("route: settings hang under the screen they cover", () => {
  // The dialog is drawn OVER a screen, and closing it returns there, so the
  // address keeps that screen. The categories themselves are the
  // installation's and the same in both modes.
  const onSession = withSettings({ kind: "code", tabKey: "s-1" }, "providers");
  assertEquals(urlOf(onSession), "/code/s/s-1/settings/providers");
  roundTrip(onSession);
  roundTrip(withSettings({ kind: "stella", agentId: null }, "models"));
  roundTrip(withSettings({ kind: "code", tabKey: null }, "overview"));
});

test("route: a settings address without a category opens the dialog", () => {
  // The app menu's way in: the dialog picks its first screen for the layout
  // (一般 beside the navigation, the list on a narrow window).
  const state = withSettings({ kind: "code", tabKey: null }, null);
  assertEquals(urlOf(state), "/code/settings");
  roundTrip(state);
  roundTrip(withSettings({ kind: "stella", agentId: "a-1" }, null));
});

test("route: / is the start address", () => {
  assertEquals(parseUrl("/"), at({ kind: "start" }));
  assertEquals(urlOf(at({ kind: "start" })), "/");
});

test("route: the first-run setup is a place of its own", () => {
  // The wizard has an address because the address is what says which screen
  // is showing: `/` sends a reader there while the installation's setup is
  // unfinished, and a reload has to keep them there.
  assertEquals(urlOf(at({ kind: "setup" })), "/setup");
  roundTrip(at({ kind: "setup" }));
  // Its settings dialog hangs under it like any other screen's: the title
  // bar's menu opens settings during the wizard, and closing returns there.
  roundTrip(withSettings({ kind: "setup" }, null));
  roundTrip(withSettings({ kind: "setup" }, "providers"));
});

test("route: a path under /setup stays the setup", () => {
  // A step is not an address of its own (the wizard writes each choice as it
  // is made, so there is nothing to return to): an invented sub-path is the
  // wizard, not a screen this app has.
  assertEquals(parseUrl("/setup/welcome"), at({ kind: "setup" }));
  assertEquals(parseUrl("/setup/unknown/general"), at({ kind: "setup" }));
});

test("route: an unknown path is the start address", () => {
  // A removed route or a typo resolves to the first screen rather than to an
  // error the app would have to invent a page for.
  assertEquals(parseUrl("/nope"), at({ kind: "start" }));
  assertEquals(parseUrl("/%zz"), at({ kind: "start" }));
});

test("route: a malformed path inside a mode is that mode's top", () => {
  // The reader was already in the mode, and a missing id does not unmake
  // that: `/code/s` is the new-session screen, not the start address.
  for (const path of ["/code/s", "/code/p/peer-1", "/code/p/s-1", "/code/x"]) {
    assertEquals(parseUrl(path), at({ kind: "code", tabKey: null }), path);
  }
});

test("route: settings over the agent list do not name an agent", () => {
  // The dialog hangs under the screen it covers, and `settings` is the one
  // segment there that is not an agent id.
  assertEquals(
    parseUrl("/agents/settings/providers"),
    withSettings({ kind: "stella", agentId: null }, "providers"),
  );
  assertEquals(
    parseUrl("/agents/a-1/settings"),
    withSettings({ kind: "stella", agentId: "a-1" }, null),
  );
});

test("route: a category the dialog does not have leaves the dialog open", () => {
  // A category is a position in a list, not a document that can be missing:
  // the reader gets the dialog they asked for, on its first page.
  assertEquals(
    parseUrl("/code/settings/gone"),
    withSettings({ kind: "code", tabKey: null }, null),
  );
  // Nothing after the category is a path this app has.
  assertEquals(
    parseUrl("/code/settings/overview/extra"),
    at({ kind: "code", tabKey: null }),
  );
});

test("route: settings on the start address are not settings", () => {
  // There is no mode, so no category set to name: the start address is the
  // screen.
  assertEquals(parseUrl("/settings/overview"), at({ kind: "start" }));
});

test("route: trailing slashes and doubled slashes are the same path", () => {
  assertEquals(parseUrl("/code/"), at({ kind: "code", tabKey: null }));
  assertEquals(
    parseUrl("//code//s//s-1//"),
    at({ kind: "code", tabKey: "s-1" }),
  );
});

test("route: a malformed escape inside a mode does not throw", () => {
  // `decodeURIComponent("%zz")` throws, and a typed URL must not take the app
  // down: the segment keeps its spelling and names a session id that happens
  // to be "%zz", which is a session the server will answer is missing.
  assertEquals(parseUrl("/code/s/%zz"), at({ kind: "code", tabKey: "%zz" }));
});

test("route: every category round-trips", () => {
  // The category segment is the dialog's own id (categories.ts): a name that
  // is valid must survive the trip.
  for (const category of SETTINGS_CATEGORIES) {
    roundTrip(withSettings({ kind: "code", tabKey: "s-1" }, category));
    roundTrip(withSettings({ kind: "stella", agentId: null }, category));
  }
});
