import { assertEquals } from "@std/assert";
import { peerLabel } from "./peers.ts";

Deno.test("peerLabel: the registered name wins", () => {
  assertEquals(
    peerLabel({ name: "自宅", url: "http://100.64.0.5:8000" }, "peer1"),
    "自宅",
  );
  // Surrounding blanks are not part of the name (it is free text).
  assertEquals(
    peerLabel({ name: " 自宅 ", url: "http://100.64.0.5:8000" }, "peer1"),
    "自宅",
  );
});

Deno.test("peerLabel: a nameless entry is labelled by its URL's host", () => {
  assertEquals(
    peerLabel({ name: "", url: "https://host.tailnet.ts.net" }, "peer1"),
    "host.tailnet.ts.net",
  );
  // The port is part of the host: it is how two servers on one machine
  // differ.
  assertEquals(
    peerLabel({ name: "   ", url: "http://100.64.0.5:8000/" }, "peer1"),
    "100.64.0.5:8000",
  );
  assertEquals(
    peerLabel({ name: "", url: "https://[::1]:8443" }, "peer1"),
    "[::1]:8443",
  );
});

Deno.test("peerLabel: unusable entries fall back, never to an empty label", () => {
  // An entry with neither name nor URL: the id at least identifies it.
  assertEquals(peerLabel({ name: "", url: "" }, "peer1"), "peer1");
  assertEquals(peerLabel(undefined, "peer1"), "peer1");
  // "homeserver:8000" parses as a URL whose scheme is "homeserver", which
  // leaves its host empty; the raw text is all there is to show. (The
  // registry's URL field is free text — only connecting and testing
  // validate the scheme.)
  assertEquals(
    peerLabel({ name: "", url: "homeserver:8000" }, "peer1"),
    "homeserver:8000",
  );
  // A value that is not a URL at all.
  assertEquals(
    peerLabel({ name: "", url: "homeserver" }, "peer1"),
    "homeserver",
  );
});
