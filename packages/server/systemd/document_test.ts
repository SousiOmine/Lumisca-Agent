import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  DISPLAY_TOKEN,
  DOCUMENT_KEYS,
  documentForDisplay,
  generateToken,
  parseDocument,
  renderDocument,
  SERVICE_RESTART_MODE,
  ServiceDefinitionError,
  type ServiceValues,
  splitHosts,
} from "./document.ts";
import { SERVER_STARTUP_ENV_KEYS } from "../startup.ts";

function values(patch: Partial<ServiceValues> = {}): ServiceValues {
  return {
    host: "127.0.0.1",
    port: 8000,
    db: undefined,
    allowedHosts: [],
    token: "abc123",
    xdgConfigHome: undefined,
    ...patch,
  };
}

Deno.test("a rendered document round-trips through the parser", () => {
  const rendered = renderDocument(
    values({
      db: "/home/me/lumisca.db",
      allowedHosts: ["homeserver", "100.64.0.5"],
      xdgConfigHome: "/home/me/.config",
    }),
  );
  assertEquals(parseDocument(rendered), {
    host: "127.0.0.1",
    port: 8000,
    db: "/home/me/lumisca.db",
    allowedHosts: ["homeserver", "100.64.0.5"],
    token: "abc123",
    xdgConfigHome: "/home/me/.config",
  });
  // The same values always render the same text: an install that changes
  // nothing rewrites an identical file.
  assertEquals(renderDocument(values()), renderDocument(values()));
});

Deno.test("the document pins the restart mode the unit requires", () => {
  assert(
    renderDocument(values()).includes(
      `LUMISCA_UPDATE_RESTART="${SERVICE_RESTART_MODE}"`,
    ),
  );
  assertEquals(parseDocument("LUMISCA_UPDATE_RESTART=supervisor"), {});
  // Another mode would contradict the unit's Restart=always.
  assertThrows(
    () => parseDocument("LUMISCA_UPDATE_RESTART=none"),
    ServiceDefinitionError,
  );
});

Deno.test("optional values are omitted rather than written empty", () => {
  const rendered = renderDocument(values());
  assert(!rendered.includes("LUMISCA_DB"));
  assert(!rendered.includes("LUMISCA_ALLOWED_HOSTS"));
  assert(!rendered.includes("XDG_CONFIG_HOME"));
  // A document that omits them reads back as "not set", so the value falls to
  // the layer below.
  assertEquals(parseDocument(rendered).db, undefined);
  assertEquals(parseDocument(rendered).allowedHosts, undefined);
});

Deno.test("values with spaces, quotes and backslashes survive a round trip", () => {
  const rendered = renderDocument(values({ db: '/home/me/my "db"\\x.db' }));
  assertEquals(parseDocument(rendered).db, '/home/me/my "db"\\x.db');
});

Deno.test("comments, blank lines and single quotes are read like systemd does", () => {
  const parsed = parseDocument(
    [
      "# a comment",
      "; another",
      "",
      "LUMISCA_HOST='192.0.2.1'",
      "LUMISCA_PORT=9000",
    ].join("\n"),
  );
  assertEquals(parsed, { host: "192.0.2.1", port: 9000 });
});

Deno.test("a document this server cannot read exactly is rejected, not guessed", () => {
  // An unknown key is a typo'd configuration: ignoring it would leave remote
  // clients with a 403 and nothing to point at.
  const unknown = assertThrows(
    () => parseDocument("LUMISCA_ALLOWED_HOST=homeserver"),
    ServiceDefinitionError,
  );
  assert(unknown.message.includes("LUMISCA_ALLOWED_HOST"));
  assertThrows(
    () => parseDocument("LUMISCA_HOST"),
    ServiceDefinitionError,
    "KEY=value の形式ではありません",
  );
  assertThrows(
    () => parseDocument('LUMISCA_HOST="unterminated'),
    ServiceDefinitionError,
    "引用符が閉じていません",
  );
  assertThrows(
    () => parseDocument('LUMISCA_HOST="a\\qb"'),
    ServiceDefinitionError,
    "対応していないエスケープ",
  );
  assertThrows(
    () => parseDocument('LUMISCA_HOST="a" b'),
    ServiceDefinitionError,
    "引用符が閉じていません",
  );
  assertThrows(
    () => parseDocument("LUMISCA_TOKEN="),
    ServiceDefinitionError,
    "LUMISCA_TOKEN が空です",
  );
  assertThrows(
    () => parseDocument("LUMISCA_PORT=70000"),
    ServiceDefinitionError,
    "LUMISCA_PORT が不正です",
  );
});

Deno.test("a malformed document names the line it failed on", () => {
  const error = assertThrows(
    () => parseDocument('LUMISCA_HOST="127.0.0.1"\nLUMISCA_BOGUS=1'),
    ServiceDefinitionError,
  );
  assert(error.message.includes("2 行目"), error.message);
});

Deno.test("documents may only carry the launcher keys the server reads", () => {
  // The single source of what a launcher may set is startup.ts; the document
  // adds XDG_CONFIG_HOME (the settings file lives under it) and nothing else.
  for (const key of DOCUMENT_KEYS) {
    if (key === "XDG_CONFIG_HOME") continue;
    assert(
      (SERVER_STARTUP_ENV_KEYS as readonly string[]).includes(key),
      `${key} must be a launcher key`,
    );
  }
  assertEquals(
    DOCUMENT_KEYS.filter((key) => key === "XDG_CONFIG_HOME").length,
    1,
  );
});

Deno.test("the displayed document hides the credential", () => {
  const rendered = renderDocument(values({ token: "super-secret-token" }));
  const shown = documentForDisplay(rendered);
  assert(!shown.includes("super-secret-token"));
  assert(shown.includes("LUMISCA_TOKEN=<伏せ字>"));
  // Only the credential line is touched.
  assertEquals(
    shown.replace(/^LUMISCA_TOKEN=.*$/m, "LUMISCA_TOKEN=x"),
    rendered.replace(/^LUMISCA_TOKEN=.*$/m, "LUMISCA_TOKEN=x"),
  );
  // A document that carries no credential line displays unchanged.
  assertEquals(documentForDisplay("LUMISCA_HOST=x\n"), "LUMISCA_HOST=x\n");
});

Deno.test("a generated token is a fresh 32-byte hex secret", () => {
  const first = generateToken();
  assertEquals(first.length, 64);
  assert(/^[0-9a-f]{64}$/.test(first));
  assert(first !== generateToken());
  assertEquals(DISPLAY_TOKEN, "not-installed");
});

Deno.test("host lists are normalized the way the server reads them", () => {
  assertEquals(splitHosts(" A.example , ,b.example,"), [
    "a.example",
    "b.example",
  ]);
  assertEquals(splitHosts("a.example,a.example"), ["a.example"]);
  assertEquals(splitHosts(""), []);
});
