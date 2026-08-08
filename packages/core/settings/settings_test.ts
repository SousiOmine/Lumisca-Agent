import { join } from "node:path";
import { assertEquals, assertThrows } from "@std/assert";
import { parseJsonc, SettingsFileError } from "./jsonc.ts";
import { resolveSettingsPath } from "./path.ts";
import { createFileSettingsRepo, createInMemorySettingsRepo } from "./repo.ts";

// --- parseJsonc -----------------------------------------------------------

Deno.test("parseJsonc strips comments and trailing commas", () => {
  const text = `{
    // テーマ設定
    "theme": "dark", /* block comment */
    "api_key": {
      "anthropic": "sk-test", // trailing comma
    },
    "connections": [],
  }`;
  assertEquals(parseJsonc(text), {
    theme: "dark",
    api_key: { anthropic: "sk-test" },
    connections: [],
  });
});

Deno.test("parseJsonc keeps string literals intact", () => {
  const text = `{
    "url": "http://example.com//path",
    "code": "a /* not a comment */ b",
    "trailing": "x,",
  }`;
  assertEquals(parseJsonc(text), {
    url: "http://example.com//path",
    code: "a /* not a comment */ b",
    trailing: "x,",
  });
});

Deno.test("parseJsonc throws SettingsFileError with position and path", () => {
  assertThrows(
    () => parseJsonc('{\n  "theme": ,\n}', "/tmp/settings.jsonc"),
    SettingsFileError,
  );
  assertThrows(
    () => parseJsonc('{ "a": }', "settings.jsonc"),
    SettingsFileError,
    "settings.jsonc",
  );
});

// --- createFileSettingsRepo ------------------------------------------------

Deno.test("file settings repo: string roundtrip and persistence", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-settings-" });
  const path = join(dir, "settings.jsonc");
  try {
    const repo = createFileSettingsRepo(path);
    assertEquals(repo.get("missing"), undefined);
    repo.set("theme", "dark");
    repo.set("mcp_servers", JSON.stringify({ mcpServers: { test: {} } }));
    assertEquals(repo.get("theme"), "dark");
    assertEquals(
      repo.get("mcp_servers"),
      JSON.stringify({ mcpServers: { test: {} } }),
    );

    // A second repo on the same file sees the stored settings.
    const reopened = createFileSettingsRepo(path);
    assertEquals(reopened.get("theme"), "dark");
    assertEquals(reopened.list().get("theme"), "dark");
    assertEquals(reopened.list().has("mcp_servers"), true);

    reopened.delete("theme");
    assertEquals(createFileSettingsRepo(path).get("theme"), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("file settings repo: JSON values are written natively", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-settings-" });
  const path = join(dir, "settings.jsonc");
  try {
    const repo = createFileSettingsRepo(path);
    repo.set("connections", JSON.stringify([{ id: "srv-1", name: "自宅" }]));
    repo.set("api_key:anthropic", "sk-test");
    repo.set("theme", "dark");

    const stored = JSON.parse(Deno.readTextFileSync(path)) as Record<
      string,
      unknown
    >;
    assertEquals(stored.connections, [{ id: "srv-1", name: "自宅" }]);
    assertEquals(stored["api_key:anthropic"], "sk-test");
    assertEquals(stored.theme, "dark");
    // Values read back exactly as they were set.
    assertEquals(repo.get("connections"), '[{"id":"srv-1","name":"自宅"}]');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("file settings repo: missing file means empty settings", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-settings-" });
  const path = join(dir, "nested", "settings.jsonc");
  try {
    const repo = createFileSettingsRepo(path);
    assertEquals(repo.list().size, 0);
    repo.set("theme", "light"); // creates the parent directory
    assertEquals(createFileSettingsRepo(path).get("theme"), "light");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("file settings repo: malformed file fails fast with its path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-settings-" });
  const path = join(dir, "settings.jsonc");
  try {
    Deno.writeTextFileSync(path, '{ "theme": ,}');
    assertThrows(
      () => createFileSettingsRepo(path),
      SettingsFileError,
      path,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("file settings repo: non-object top level is rejected", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-settings-" });
  const path = join(dir, "settings.jsonc");
  try {
    Deno.writeTextFileSync(path, "[1, 2, 3]");
    assertThrows(
      () => createFileSettingsRepo(path),
      SettingsFileError,
      "must contain a JSON object",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- createInMemorySettingsRepo ---------------------------------------------

Deno.test("in-memory settings repo: basic roundtrip", () => {
  const repo = createInMemorySettingsRepo();
  repo.set("theme", "dark");
  repo.set("api_key:anthropic", "sk-test");
  assertEquals(repo.get("theme"), "dark");
  assertEquals(repo.get("api_key:anthropic"), "sk-test");
  assertEquals(repo.list().size, 2);
  repo.delete("theme");
  assertEquals(repo.get("theme"), undefined);
  assertEquals(repo.list().size, 1);
});

// --- resolveSettingsPath ----------------------------------------------------

Deno.test("resolveSettingsPath honors XDG_CONFIG_HOME", () => {
  const prev = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", join("C:", "xdg"));
    assertEquals(
      resolveSettingsPath(),
      join("C:", "xdg", "lumisca-agent", "settings.jsonc"),
    );
  } finally {
    if (prev === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", prev);
  }
});

Deno.test("resolveSettingsPath defaults to ~/.config", () => {
  const prev = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.delete("XDG_CONFIG_HOME");
    assertEquals(
      resolveSettingsPath(),
      join(
        Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME")!,
        ".config",
        "lumisca-agent",
        "settings.jsonc",
      ),
    );
  } finally {
    if (prev === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", prev);
  }
});
