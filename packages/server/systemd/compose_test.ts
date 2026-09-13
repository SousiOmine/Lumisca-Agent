import { assert, assertEquals, assertThrows } from "@std/assert";
import { resolve as resolvePath } from "node:path";
import {
  pathUnitValue,
  quoteUnitValue,
  renderTemplate,
  renderUnit,
  resolveValues,
  type ServicePaths,
} from "./compose.ts";
import { ServiceDefinitionError, type ServiceValues } from "./document.ts";
import { SERVICE_USAGE } from "./plan.ts";

/** The shipped template. Imported directly (not through mod.ts) so the test
 * fails if the composer and the template drift apart. */
import { SERVICE_UNIT_TEMPLATE as SHIPPED_TEMPLATE } from "./template.ts";

const PATHS: ServicePaths = {
  unitPath: "/home/me/.config/systemd/user/lumisca.service",
  documentPath: "/home/me/.config/lumisca-agent/service.env",
  installDir: "/home/me/lumisca",
  home: "/home/me",
  execPath: "/home/me/lumisca/lumisca-server",
};

function resolve(
  patch: Partial<Parameters<typeof resolveValues>[0]> = {},
): ServiceValues {
  return resolveValues({
    installed: {},
    flags: {},
    xdgConfigHome: undefined,
    defaults: { host: "127.0.0.1", port: 8000 },
    cwd: "/work",
    generateToken: () => "generated-token",
    ...patch,
  });
}

Deno.test("the shipped template renders, and its placeholders match the composer", () => {
  const unit = renderUnit(SHIPPED_TEMPLATE, PATHS);
  assert(!unit.includes("{{"), "no placeholder may survive rendering");
  // Commands and environment assignments are quoted so a path with a space
  // stays one item; the path directives are not, because systemd does not
  // unquote them (see pathUnitValue; measured with systemd-analyze).
  assert(unit.includes(`ExecStart=${quoteUnitValue(PATHS.execPath)}`));
  assert(unit.includes(`WorkingDirectory=${pathUnitValue(PATHS.installDir)}`));
  assert(unit.includes(`Environment=HOME=${quoteUnitValue(PATHS.home)}`));
  assert(
    unit.includes(`EnvironmentFile=${pathUnitValue(PATHS.documentPath)}`),
  );
  // The directives the lifecycle depends on: restart on its own exit (an
  // applied update) and stop inside the drain budget (shutdown.ts).
  assert(unit.includes("Restart=always"));
  assert(unit.includes("Type=simple"));
  assert(unit.includes("WantedBy=default.target"));
  assert(unit.includes("TimeoutStopSec=10"));
  // Rendering is deterministic: `status` compares the text byte for byte.
  assertEquals(renderUnit(SHIPPED_TEMPLATE, PATHS), unit);
});

Deno.test("a template and its values must agree in both directions", () => {
  assertEquals(renderTemplate("a {{one}} b", { one: "1" }), "a 1 b");
  assertThrows(
    () => renderTemplate("a {{one}} b", {}),
    ServiceDefinitionError,
    "プレースホルダ one",
  );
  assertThrows(
    () => renderTemplate("a b", { one: "1" }),
    ServiceDefinitionError,
    "使わない値があります",
  );
});

Deno.test("unit values are quoted and % is escaped for systemd", () => {
  // A path with a space must stay one argument.
  assertEquals(quoteUnitValue("/home/my server/x"), '"/home/my server/x"');
  // systemd expands a single % as a specifier, so a literal one doubles.
  assertEquals(quoteUnitValue("/home/100%/x"), '"/home/100%%/x"');
  assertEquals(quoteUnitValue('a"b'), '"a\\"b"');
  assertEquals(quoteUnitValue("a\\b"), '"a\\\\b"');
});

Deno.test("path directives take their value verbatim, quotes and all", () => {
  // Measured with `systemd-analyze --user verify` (systemd 255): quoting
  // WorkingDirectory= or EnvironmentFile= makes systemd read the quote as part
  // of the path ("path is not absolute"), while the unquoted spelling keeps a
  // space intact because the whole rest of the line is the value.
  assertEquals(pathUnitValue("/home/my server/x"), "/home/my server/x");
  assertEquals(pathUnitValue("/home/100%/x"), "/home/100%%/x");
  // A leading or trailing space is stripped by the parser, which would point
  // the directive at a different path: refuse instead of mis-install.
  assertThrows(
    () => pathUnitValue("/home/my server/x "),
    ServiceDefinitionError,
    "空白",
  );
  assertThrows(
    () => pathUnitValue(" /home/x"),
    ServiceDefinitionError,
    "空白",
  );
});

Deno.test("values compose over the installed document, then the defaults", () => {
  // Nothing installed, nothing given: the defaults.
  assertEquals(resolve(), {
    host: "127.0.0.1",
    port: 8000,
    db: undefined,
    allowedHosts: [],
    token: "generated-token",
    xdgConfigHome: undefined,
  });

  // A documented credential is reused rather than regenerated, so installed
  // clients keep working across a reinstall.
  assertEquals(
    resolve({
      installed: { token: "installed-token", port: 8100 },
      generateToken: () => {
        throw new Error("must not regenerate");
      },
    }).token,
    "installed-token",
  );

  // A flag wins over the document, the document wins over the defaults, and
  // values the flag does not mention survive.
  const merged = resolve({
    installed: { host: "127.0.0.1", port: 8100, db: "/data/old.db" },
    flags: { port: 8200 },
  });
  assertEquals(merged.port, 8200);
  assertEquals(merged.db, "/data/old.db");

  // A relative database path resolves against the invoking directory, so the
  // unit does not depend on systemd's working directory.
  assertEquals(
    resolve({ flags: { db: "data/x.db" } }).db,
    resolvePath("/work", "data/x.db"),
  );
});

Deno.test("exposing the server needs the authorities clients will use", () => {
  // A wildcard or specific non-loopback bind without LUMISCA_ALLOWED_HOSTS
  // would answer 403 to every remote browser with nothing to explain it.
  const error = assertThrows(
    () => resolve({ flags: { host: "0.0.0.0" } }),
    ServiceDefinitionError,
  );
  assert(error.message.includes("--allowed-hosts"), error.message);
  assertEquals(
    resolve({
      flags: { host: "100.64.0.5", allowedHosts: ["homeserver"] },
    }).host,
    "100.64.0.5",
  );
  // Loopback needs no list.
  assertEquals(resolve({ flags: { host: "::1" } }).host, "::1");
  // An installed list counts as well.
  assertEquals(
    resolve({
      flags: { host: "0.0.0.0" },
      installed: { allowedHosts: ["homeserver"] },
    }).allowedHosts,
    ["homeserver"],
  );
});

Deno.test("compose rejects values that would break the document or the unit", () => {
  // A bind address and a Host-guard authority are matched verbatim against
  // what the client sends, so whitespace in them is a configuration error.
  assertThrows(
    () => resolve({ flags: { host: "bad host" } }),
    ServiceDefinitionError,
    "空白を含められません",
  );
  assertThrows(
    () => resolve({ flags: { host: "127.0.0.1", allowedHosts: ["a b"] } }),
    ServiceDefinitionError,
    "空白を含められません",
  );
  // A newline would split one value into two lines of the document.
  assertThrows(
    () => resolve({ flags: { host: "127.0.0\n1" } }),
    ServiceDefinitionError,
    "制御文字",
  );
  assertThrows(
    () => resolve({ installed: { token: "" } }),
    ServiceDefinitionError,
    "空",
  );
  assertThrows(
    () => resolve({ flags: { port: 0 } }),
    ServiceDefinitionError,
    "LUMISCA_PORT が不正です",
  );
  // A database path is a file system path: a space in it is legitimate.
  assertEquals(
    resolve({ flags: { db: "/data/my db/x.db" } }).db,
    "/data/my db/x.db",
  );
});

Deno.test("XDG_CONFIG_HOME is pinned so the service reads the same settings file", () => {
  assertEquals(
    resolve({ xdgConfigHome: "/home/me/.config" }).xdgConfigHome,
    "/home/me/.config",
  );
  // A reinstall from a shell without XDG_CONFIG_HOME keeps the installed pin.
  assertEquals(
    resolve({ installed: { xdgConfigHome: "/x" } }).xdgConfigHome,
    "/x",
  );
  assertEquals(resolve().xdgConfigHome, undefined);
});

Deno.test("the usage text documents the contract the flags enforce", () => {
  assert(SERVICE_USAGE.includes("--allowed-hosts"));
  assert(SERVICE_USAGE.includes("127.0.0.1"));
  assert(SERVICE_USAGE.includes("終了コード"));
});
