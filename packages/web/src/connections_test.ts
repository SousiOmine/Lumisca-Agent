import { assertEquals } from "@std/assert";
import {
  connectionLabel,
  displayedConnectionId,
  type DisplayedServer,
  originOf,
  pageUrl,
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
