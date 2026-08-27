import { assertEquals } from "@std/assert";
import {
  consumeServerStartupEnvironment,
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
