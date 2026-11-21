import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  connectionLabel,
  displayedLabel,
  hostLabel,
  isSupportedUrl,
  suggestConnectionName,
  withUrl,
} from "./connections.ts";

/**
 * The connection list's reading rules, shared by the settings page and the
 * title bar's picker. The list itself is the shell's; these cover the pure
 * part: what to call a row and which row the window is showing.
 */

const entry = (id: string, name: string, url: string) => ({
  id,
  name,
  url,
  token: "t",
});

test("isSupportedUrl accepts only the two transports the shell speaks", () => {
  assertEquals(isSupportedUrl("https://host.tailnet.ts.net"), true);
  assertEquals(isSupportedUrl("http://100.64.0.5:8000"), true);
  assertEquals(isSupportedUrl("  https://host  "), true);
  assertEquals(isSupportedUrl("ftp://host"), false);
  assertEquals(isSupportedUrl("host:8000"), false);
  assertEquals(isSupportedUrl(""), false);
});

test("connectionLabel prefers the name, then the host, then the id", () => {
  assertEquals(
    connectionLabel(entry("id", " Home ", "https://h.example")),
    "Home",
  );
  assertEquals(
    connectionLabel(entry("id", "  ", "https://h.example:8443")),
    "h.example:8443",
  );
  // Text that only looks like a URL has no host to show, and a blank entry
  // still has to be selectable as something.
  assertEquals(
    connectionLabel(entry("id", "", "homeserver:8000")),
    "homeserver:8000",
  );
  assertEquals(connectionLabel(entry("id", "", "  ")), "id");
});

test("hostLabel keeps the host and drops the token-bearing query", () => {
  assertEquals(hostLabel("https://home.example/?token=secret"), "home.example");
  assertEquals(hostLabel("https://home.example:8443"), "home.example:8443");
  assertEquals(hostLabel("https://[::1]:8443"), "[::1]:8443");
  assertEquals(hostLabel(""), "");
  assertEquals(hostLabel(null), "");
});

test("displayedLabel names the row the shell recorded, not a matching URL", () => {
  const entries = [
    entry("a", "Home", "https://home.example"),
    entry("b", "Tailnet", "http://100.64.0.5:8000"),
  ];
  assertEquals(displayedLabel(entries, "b", null), "Tailnet");
  // A row removed while it was displayed falls back to the address's host;
  // the page URL itself carries the auth token, so it is never the label.
  assertEquals(
    displayedLabel(entries, "gone", "https://elsewhere.example/?token=x"),
    "elsewhere.example",
  );
  assertEquals(displayedLabel(entries, null, null), "");
});

test("suggestConnectionName reads the host of a URL being typed", () => {
  assertEquals(suggestConnectionName("https://home.example"), "home.example");
  assertEquals(
    suggestConnectionName("http://100.64.0.5:8000/"),
    "100.64.0.5:8000",
  );
  assertEquals(suggestConnectionName("https://[::1]:8443"), "[::1]:8443");
  // Nothing to name until the address is one this app can connect to: a
  // half-typed host must not become the server's name.
  assertEquals(suggestConnectionName(""), null);
  assertEquals(suggestConnectionName("home.example"), null);
  assertEquals(suggestConnectionName("https://"), null);
});

test("withUrl derives the name from the address, until one is typed", () => {
  const fresh = entry("id", "", "");
  // Address first (the required field), name derived from it.
  assertEquals(withUrl(fresh, "https://home.example"), {
    ...fresh,
    url: "https://home.example",
    name: "home.example",
  });
  // Typed one character at a time: the derived name keeps following the
  // address instead of sticking at the first fragment that parsed.
  let typed = withUrl(fresh, "https://h");
  assertEquals(typed.name, "h");
  typed = withUrl(typed, "https://home");
  assertEquals(typed.name, "home");
  typed = withUrl(typed, "https://home.example");
  assertEquals(typed.name, "home.example");
  // Nothing to derive yet: the name stays empty rather than collecting a
  // fragment of a half-typed address.
  assertEquals(withUrl({ ...fresh, url: "https://x" }, "http").name, "");
  // A name the user typed is never overwritten.
  assertEquals(
    withUrl(entry("id", "自宅", "https://a.example"), "https://b.example"),
    { ...entry("id", "自宅", "https://a.example"), url: "https://b.example" },
  );
  // A cleared name follows the address again.
  assertEquals(
    withUrl(entry("id", "", "https://a.example"), "https://b.example").name,
    "b.example",
  );
});
