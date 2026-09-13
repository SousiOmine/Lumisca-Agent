import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  consumeServerStartupEnvironment,
  defaultAssetsFile,
  describeListenError,
  isAddressInUseError,
  isDesktopManaged,
  parsePortValue,
  parsePortWaitMs,
  parseServerPort,
  parseUpdateRestartMode,
  PORT_WAIT_ENV_KEY,
  SERVER_STARTUP_ENV_KEYS,
  updateSupport,
} from "./startup.ts";

Deno.test("server startup environment is consumed instead of inherited by tools", () => {
  const values = new Map<string, string>([
    ["LUMISCA_DB", "C:/data/parent.db"],
    ["LUMISCA_HOME", "C:/data"],
    ["LUMISCA_REPO_ROOT", "C:/repo"],
    ["LUMISCA_ALLOWED_HOSTS", "parent.example"],
    ["LUMISCA_BROWSER_IPC_URL", "http://127.0.0.1:41000"],
    ["LUMISCA_BROWSER_TOKEN", "browser-secret"],
    ["LUMISCA_TOKEN", "server-secret"],
    ["LUMISCA_HOST", "127.0.0.1"],
    ["LUMISCA_PORT", "42000"],
    ["LUMISCA_ASSETS_FILE", "C:/assets.json"],
    ["LUMISCA_DESKTOP", "1"],
    ["LUMISCA_UPDATE_MANIFEST", "https://example.com/latest-server.json"],
    ["LUMISCA_UPDATE_RESTART", "none"],
    ["LUMISCA_PORT_WAIT_MS", "15000"],
    // Model configuration belongs to the user's development environment,
    // not to the hosting server instance, so it must remain inheritable.
    ["LUMISCA_MODEL", "test-model"],
  ]);
  const deleted: string[] = [];
  const source = {
    get: (key: string) => values.get(key),
    delete: (key: string) => {
      deleted.push(key);
      values.delete(key);
    },
  };

  const captured = consumeServerStartupEnvironment(source);

  assertEquals(captured, {
    LUMISCA_DB: "C:/data/parent.db",
    LUMISCA_HOME: "C:/data",
    LUMISCA_REPO_ROOT: "C:/repo",
    LUMISCA_ALLOWED_HOSTS: "parent.example",
    LUMISCA_BROWSER_IPC_URL: "http://127.0.0.1:41000",
    LUMISCA_BROWSER_TOKEN: "browser-secret",
    LUMISCA_TOKEN: "server-secret",
    LUMISCA_HOST: "127.0.0.1",
    LUMISCA_PORT: "42000",
    LUMISCA_ASSETS_FILE: "C:/assets.json",
    LUMISCA_DESKTOP: "1",
    LUMISCA_UPDATE_MANIFEST: "https://example.com/latest-server.json",
    LUMISCA_UPDATE_RESTART: "none",
    [PORT_WAIT_ENV_KEY]: "15000",
  });
  assertEquals(deleted, Object.keys(captured));
  assertEquals(values, new Map([["LUMISCA_MODEL", "test-model"]]));
});

Deno.test("desktop mode and update switches are read strictly", () => {
  assertEquals(isDesktopManaged("1"), true);
  assertEquals(isDesktopManaged("true"), true);
  assertEquals(isDesktopManaged("0"), false);
  assertEquals(isDesktopManaged(undefined), false);

  // Only the updater's successor sets the bind-retry budget; an invalid
  // value means "fail fast like any other launch".
  assertEquals(parsePortWaitMs("15000"), 15_000);
  assertEquals(parsePortWaitMs(undefined), 0);
  assertEquals(parsePortWaitMs(""), 0);
  assertEquals(parsePortWaitMs("soon"), 0);
  assertEquals(parsePortWaitMs("-5"), 0);
  assertEquals(parsePortWaitMs("999999999"), 5 * 60 * 1000, "bounded");

  // An unrecognized restart mode keeps the default (restart in place)
  // rather than silently never restarting.
  assertEquals(parseUpdateRestartMode(undefined), "self");
  assertEquals(parseUpdateRestartMode("self"), "self");
  assertEquals(parseUpdateRestartMode("none"), "none");
  assertEquals(parseUpdateRestartMode("NONE"), "none");
  // The service unit's mode: exit and let systemd start the new binary.
  assertEquals(parseUpdateRestartMode("supervisor"), "supervisor");
  assertEquals(parseUpdateRestartMode(" Supervisor "), "supervisor");
  assertEquals(parseUpdateRestartMode("false"), "self");
});

Deno.test("the update decision names the reason for every unsupported launch", () => {
  // Only a packaged server outside the desktop shell may replace its own
  // files. The composition root registers no update endpoints in the other
  // cases, so this decision is what decides whether /api/update/* exists at
  // all — hence the reasons (shown in the startup log).
  assertEquals(updateSupport({ desktopManaged: false, standalone: true }), {
    enabled: true,
  });

  const development = updateSupport({
    desktopManaged: false,
    standalone: false,
  });
  assertEquals(development.enabled, false);
  assertEquals(development.reason?.includes("deno run"), true);

  // The desktop shell owns the copy inside the app bundle: its own updater
  // replaces it, and the server must not fight it.
  const managed = updateSupport({ desktopManaged: true, standalone: true });
  assertEquals(managed.enabled, false);
  assertEquals(managed.reason?.includes("デスクトップ"), true);

  // A desktop-managed development run reports the desktop reason: the user
  // launched an app, not a repository checkout.
  assertEquals(
    updateSupport({ desktopManaged: true, standalone: false }).reason,
    managed.reason,
  );
});

Deno.test("parseServerPort falls back when unset or blank", () => {
  assertEquals(parseServerPort(undefined, 8000), 8000);
  assertEquals(parseServerPort("", 8000), 8000);
  assertEquals(parseServerPort("   ", 8000), 8000);
});

Deno.test("parseServerPort accepts valid ports", () => {
  assertEquals(parseServerPort("8100", 8000), 8100);
  assertEquals(parseServerPort("1", 8000), 1);
  assertEquals(parseServerPort("65535", 8000), 65535);
});

Deno.test("parseServerPort rejects garbage and out-of-range values", () => {
  // The service command validates `--port` with the same parser as
  // LUMISCA_PORT, so the accepted range is one definition, not two.
  assertEquals(parsePortValue("8100"), 8100);
  assertEquals(parsePortValue(" 8100 "), 8100);
  assertThrows(() => parsePortValue("0"), Error, "LUMISCA_PORT");
  assertThrows(() => parsePortValue("65536"), Error, "LUMISCA_PORT");
  assertThrows(() => parsePortValue(""), Error, "LUMISCA_PORT");
  assertThrows(() => parsePortValue("abc"), Error, "LUMISCA_PORT");
  for (const raw of ["abc", "0", "-1", "65536", "80.5", "80x"]) {
    assertThrows(
      () => parseServerPort(raw, 8000),
      Error,
      "LUMISCA_PORT",
      `must reject ${JSON.stringify(raw)}`,
    );
  }
});

Deno.test("isAddressInUseError matches Deno's AddrInUse", () => {
  assertEquals(isAddressInUseError(new Deno.errors.AddrInUse("taken")), true);
  const shaped = new Error("taken");
  shaped.name = "AddrInUse";
  assertEquals(isAddressInUseError(shaped), true);
  assertEquals(isAddressInUseError(new Error("boom")), false);
  assertEquals(isAddressInUseError("AddrInUse"), false);
  assertEquals(isAddressInUseError(undefined), false);
});

Deno.test("defaultAssetsFile picks up the manifest staged next to the binary", () => {
  const execPath = Deno.build.os === "windows"
    ? "C:\\opt\\lumisca\\lumisca-server.exe"
    : "/opt/lumisca/lumisca-server";
  const beside = Deno.build.os === "windows"
    ? "C:\\opt\\lumisca\\assets.json"
    : "/opt/lumisca/assets.json";
  const seen: string[] = [];
  const resolved = defaultAssetsFile(execPath, (path) => {
    seen.push(path);
    return path === beside;
  });

  assertEquals(resolved, beside);
  assertEquals(seen, [beside], "only the sibling manifest is probed");
});

Deno.test("defaultAssetsFile leaves development servers on the repository sources", () => {
  // `deno run` has no assets.json beside the runtime binary.
  assertEquals(
    defaultAssetsFile("/usr/local/bin/deno", () => false),
    undefined,
  );
  // An unreadable path is "not there", not a crash.
  assertEquals(defaultAssetsFile("/usr/local/bin/deno"), undefined);
});

Deno.test("describeListenError guides away from an occupied port", () => {
  const message = describeListenError(
    "127.0.0.1",
    8000,
    new Deno.errors.AddrInUse("taken"),
  );
  assert(message.includes("8000"), "names the port");
  assert(message.includes("netstat"), "tells how to find the holder");
  assert(message.includes("LUMISCA_PORT"), "offers another port");
});

Deno.test("describeListenError reports other listen failures plainly", () => {
  const message = describeListenError(
    "127.0.0.1",
    8000,
    new Error("permission denied"),
  );
  assert(message.includes("8000"), "names the port");
  assert(message.includes("permission denied"), "keeps the raw detail");
});

Deno.test("unset server startup variables are still removed", () => {
  const deleted: string[] = [];
  const captured = consumeServerStartupEnvironment({
    get: () => undefined,
    delete: (key) => deleted.push(key),
  });

  assertEquals(
    Object.values(captured).every((value) => value === undefined),
    true,
  );
  assertEquals(deleted, Object.keys(captured));
});

Deno.test("spawned commands inherit the cleaned process environment", async () => {
  const keys = [...SERVER_STARTUP_ENV_KEYS, "LUMISCA_MODEL"];
  const saved = new Map(keys.map((key) => [key, Deno.env.get(key)]));

  try {
    Deno.env.set("LUMISCA_PORT", "42000");
    Deno.env.set("LUMISCA_TOKEN", "server-secret");
    Deno.env.set("LUMISCA_MODEL", "test-model");
    consumeServerStartupEnvironment();

    const code = `console.log(JSON.stringify([
      Deno.env.get("LUMISCA_PORT") ?? null,
      Deno.env.get("LUMISCA_TOKEN") ?? null,
      Deno.env.get("LUMISCA_MODEL") ?? null,
    ]))`;
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["eval", code],
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.success, true, new TextDecoder().decode(output.stderr));
    assertEquals(
      JSON.parse(new TextDecoder().decode(output.stdout)),
      [null, null, "test-model"],
    );
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
