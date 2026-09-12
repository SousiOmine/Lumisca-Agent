import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  consumeServerStartupEnvironment,
  defaultAssetsFile,
  describeListenError,
  isAddressInUseError,
  parseServerPort,
  SERVER_STARTUP_ENV_KEYS,
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
  });
  assertEquals(deleted, Object.keys(captured));
  assertEquals(values, new Map([["LUMISCA_MODEL", "test-model"]]));
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
