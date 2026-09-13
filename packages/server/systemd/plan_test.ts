import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "node:path";
import {
  parseServiceArgs,
  type ServiceHost,
  servicePaths,
  ServiceUsageError,
  UNIT_NAME,
} from "./plan.ts";
import { SETTINGS_DIR_NAME } from "@lumisca/core";

function host(patch: Partial<ServiceHost> = {}): ServiceHost {
  return {
    os: "linux",
    standalone: true,
    desktopManaged: false,
    execPath: "/home/me/lumisca/lumisca-server",
    home: "/home/me",
    user: "me",
    cwd: "/work",
    xdgConfigHome: undefined,
    ...patch,
  };
}

Deno.test("installed files live where systemd and the settings file expect them", () => {
  // Paths are joined the way the platform joins them (the suite runs on
  // Windows, macOS, and Linux), so the expectation is built, not spelled.
  assertEquals(servicePaths(host()), {
    unitPath: join("/home/me", ".config", "systemd", "user", UNIT_NAME),
    documentPath: join(
      "/home/me",
      ".config",
      SETTINGS_DIR_NAME,
      "service.env",
    ),
    installDir: "/home/me/lumisca",
    home: "/home/me",
    execPath: "/home/me/lumisca/lumisca-server",
  });
  // XDG_CONFIG_HOME moves both, together: the unit and the settings file it
  // configures must not end up in different homes.
  const moved = servicePaths(host({ xdgConfigHome: "/xdg" }));
  assertEquals(moved.unitPath, join("/xdg", "systemd", "user", UNIT_NAME));
  assertEquals(
    moved.documentPath,
    join("/xdg", SETTINGS_DIR_NAME, "service.env"),
  );
});

Deno.test("the four verbs parse with their own options", () => {
  assertEquals(parseServiceArgs(["install"]), {
    verb: "install",
    flags: {},
    defaults: false,
  });
  assertEquals(
    parseServiceArgs(["install", "--host", "0.0.0.0", "--port", "9000"]),
    {
      verb: "install",
      flags: { host: "0.0.0.0", port: 9000 },
      defaults: false,
    },
  );
  // `--flag=value` is what most CLIs accept; both spellings must work.
  assertEquals(
    parseServiceArgs(["install", "--port=9100"]).flags.port,
    9100,
  );
  assertEquals(parseServiceArgs(["status"]).verb, "status");
  assertEquals(parseServiceArgs(["uninstall"]).verb, "uninstall");
  assertEquals(parseServiceArgs(["config"]), {
    verb: "config",
    flags: {},
    defaults: false,
  });
  assertEquals(parseServiceArgs(["config", "--defaults"]), {
    verb: "config",
    flags: {},
    defaults: true,
  });
  assertEquals(parseServiceArgs(["--help"]).verb, "help");
  assertEquals(parseServiceArgs(["install", "-h"]).verb, "help");
});

Deno.test("host lists normalize and accumulate across repeats", () => {
  assertEquals(
    parseServiceArgs([
      "install",
      "--host",
      "0.0.0.0",
      "--allowed-hosts",
      "A.example,b.example",
      "--allowed-hosts",
      "b.example,c.example",
    ]).flags.allowedHosts,
    ["a.example", "b.example", "c.example"],
  );
});

Deno.test("options from another mode are usage errors, never ignored", () => {
  // A silently ignored --port would install a server somewhere the operator
  // did not ask for.
  assertThrows(
    () => parseServiceArgs(["status", "--port", "9000"]),
    ServiceUsageError,
    "オプションを受け取りません",
  );
  assertThrows(
    () => parseServiceArgs(["uninstall", "--host", "0.0.0.0"]),
    ServiceUsageError,
    "オプションを受け取りません",
  );
  assertThrows(
    () => parseServiceArgs(["install", "--defaults"]),
    ServiceUsageError,
    "config でのみ",
  );
  assertThrows(
    () => parseServiceArgs(["config", "--defaults", "--port", "9000"]),
    ServiceUsageError,
    "併用できません",
  );
  assertThrows(
    () => parseServiceArgs(["install", "--manifest", "x"]),
    ServiceUsageError,
    "不明なオプション",
  );
  assertThrows(
    () => parseServiceArgs(["restart"]),
    ServiceUsageError,
    "不明なサブコマンド",
  );
  assertThrows(
    () => parseServiceArgs([]),
    ServiceUsageError,
    "サブコマンドを指定してください",
  );
  assertThrows(
    () => parseServiceArgs(["install", "extra"]),
    ServiceUsageError,
    "不明な引数",
  );
});

Deno.test("option values are validated where they enter", () => {
  assertThrows(
    () => parseServiceArgs(["install", "--port", "0"]),
    ServiceUsageError,
    "1〜65535",
  );
  assertThrows(
    () => parseServiceArgs(["install", "--port", "abc"]),
    ServiceUsageError,
    "1〜65535",
  );
  assertThrows(
    () => parseServiceArgs(["install", "--port"]),
    ServiceUsageError,
    "値が必要です",
  );
  assertThrows(
    () => parseServiceArgs(["install", "--token", "with space"]),
    ServiceUsageError,
    "空白を含まない",
  );
  assertThrows(
    () => parseServiceArgs(["install", "--host", "bad host"]),
    ServiceUsageError,
    "値が不正です",
  );
  assertThrows(
    () => parseServiceArgs(["install", "--db", ""]),
    ServiceUsageError,
    "空にできません",
  );
  assertThrows(
    () => parseServiceArgs(["install", "--allowed-hosts", " , "]),
    ServiceUsageError,
    "空にできません",
  );
  // A path with a space is legitimate; it reaches the parser as one argument.
  assertEquals(
    parseServiceArgs(["install", "--db", "/data/my db/x.db"]).flags.db,
    "/data/my db/x.db",
  );
  // A token that is safe in a URL query is accepted as-is.
  assertEquals(
    parseServiceArgs(["install", "--token", "a-b_c.d~e"]).flags.token,
    "a-b_c.d~e",
  );
});

Deno.test("a token given on the command line is what the layer carries", () => {
  const parsed = parseServiceArgs(["install", "--token", "abc123"]);
  assert(
    !("xdgConfigHome" in parsed.flags),
    "flags cannot pin the config home",
  );
  assertEquals(parsed.flags.token, "abc123");
});
