import { assertEquals } from "@std/assert";
import {
  connectionLabel,
  displayedConnectionId,
  type DisplayedServer,
  originOf,
  pageUrl,
  serverLabel,
  suggestConnectionName,
  withUrl,
} from "./connections.ts";

/**
 * The connection registry's reading rules, shared by the settings list and
 * the title bar's picker. The desktop bridge is not available under Deno, so
 * these cover the pure part: which entry is the one being shown, and what to
 * call it.
 */

const entry = (id: string, name: string, url: string) => ({
  id,
  name,
  url,
  token: "t",
});

Deno.test("pageUrl keeps the token in the query and drops trailing slashes", () => {
  assertEquals(
    pageUrl("https://host.tailnet.ts.net/", "abc"),
    "https://host.tailnet.ts.net/?token=abc",
  );
  // A token with characters the query would otherwise split on.
  assertEquals(
    pageUrl("http://100.64.0.5:8000", "a b&c"),
    "http://100.64.0.5:8000/?token=a%20b%26c",
  );
});

Deno.test("originOf reduces the spellings of one server to one string", () => {
  assertEquals(
    originOf("https://host.tailnet.ts.net/"),
    "https://host.tailnet.ts.net",
  );
  assertEquals(
    originOf("https://host.tailnet.ts.net/?token=abc"),
    "https://host.tailnet.ts.net",
  );
  // Free text (no scheme) keeps its own spelling rather than throwing.
  assertEquals(originOf("homeserver:8000"), "homeserver:8000");
});

Deno.test("displayedConnectionId names the local server with an empty id", () => {
  const connections = [entry("a", "Home", "https://home.example")];
  const local: DisplayedServer = { mode: "local", url: null };
  assertEquals(displayedConnectionId(connections, local), "");
});

Deno.test("displayedConnectionId matches a remote by origin, not by name", () => {
  const connections = [
    entry("a", "Home", "https://home.example"),
    entry("b", "Tailnet", "http://100.64.0.5:8000"),
  ];
  // The page URL carries a token and a slash the stored origin does not.
  const remote: DisplayedServer = {
    mode: "remote",
    url: pageUrl("https://home.example", "tok"),
  };
  assertEquals(displayedConnectionId(connections, remote), "a");
});

Deno.test("displayedConnectionId: a server the registry does not know is null", () => {
  const connections = [entry("a", "Home", "https://home.example")];
  const stranger: DisplayedServer = {
    mode: "remote",
    url: "https://elsewhere.example/",
  };
  // Not "the first row": the picker shows the server's own origin instead of
  // claiming one of the entries is it.
  assertEquals(displayedConnectionId(connections, stranger), null);
  assertEquals(
    displayedConnectionId(connections, { mode: "remote", url: null }),
    null,
  );
  // No shell state yet (a plain browser, or the first read): nothing shown.
  assertEquals(displayedConnectionId(connections, null), null);
});

Deno.test("connectionLabel prefers the name, then the host, then the id", () => {
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

Deno.test("serverLabel prefers the shell's name, then the URL's host", () => {
  // The name the shell was switched with: the only place that knows it,
  // because a remote page's registry is that server's own.
  assertEquals(
    serverLabel("自宅", "https://home.example/?token=abc"),
    "自宅",
  );
  assertEquals(serverLabel("  自宅  ", null), "自宅");
  // No recorded name (a server reached from the startup screen): never the
  // page URL, which carries the auth token — its host identifies it.
  assertEquals(
    serverLabel(null, "https://home.example:8443/?token=secret"),
    "home.example:8443",
  );
  assertEquals(serverLabel(undefined, undefined), "");
});

Deno.test("suggestConnectionName reads the host of a URL being typed", () => {
  assertEquals(suggestConnectionName("https://home.example"), "home.example");
  assertEquals(
    suggestConnectionName("http://100.64.0.5:8000/"),
    "100.64.0.5:8000",
  );
  assertEquals(suggestConnectionName("https://[::1]:8443"), "[::1]:8443");
  // Nothing to name until the address is one this app can connect to: a
  // half-typed hosts must not become the server's name.
  assertEquals(suggestConnectionName(""), null);
  assertEquals(suggestConnectionName("home.example"), null);
  assertEquals(suggestConnectionName("https://"), null);
});

Deno.test("withUrl derives the name from the address, until one is typed", () => {
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
