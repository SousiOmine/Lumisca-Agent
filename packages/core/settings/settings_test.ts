import { test } from "bun:test";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join, join as pathJoin } from "node:path";
import { assertEquals, assertThrows } from "@std/assert";
import { removeDirRetry } from "../test-utils.ts";
import { parseJsonc, SettingsFileError } from "./jsonc.ts";
import { resolveSettingsPath } from "./path.ts";
import { createFileSettingsRepo, createInMemorySettingsRepo } from "./repo.ts";

// --- parseJsonc -----------------------------------------------------------

test("parseJsonc strips comments and trailing commas", () => {
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

test("parseJsonc keeps string literals intact", () => {
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

test("parseJsonc throws SettingsFileError with position and path", () => {
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

test("file and memory stores return the same text for the same value", async () => {
  // The bug this pins down: the file backend parsed "1.50" into the number
  // 1.5 and wrote it back as "1.5", while the memory backend kept "1.50".
  // A test against the memory store passed, and production read a different
  // value. Both now write strings and parse only on getJson.
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-settings-"));
  const file = createFileSettingsRepo(pathJoin(dir, "settings.json"));
  const memory = createInMemorySettingsRepo();
  try {
    for (const store of [file, memory]) {
      store.set("plain", "1.50");
      store.setJson("number", 1.5);
      store.setJson("null", null);
      store.setJson("code", "007");
    }
    for (const store of [file, memory]) {
      assertEquals(store.get("plain"), "1.50");
      assertEquals(store.get("number"), "1.5");
      assertEquals(store.get("null"), "null");
      assertEquals(store.get("code"), '"007"');
      assertEquals(store.getJson<number>("number"), 1.5);
      assertEquals(store.getJson<null>("null"), null);
      assertEquals(store.getJson<string>("code"), "007");
    }
    // A reopened file agrees too: the value on disk is a JSON string.
    const reopened = createFileSettingsRepo(pathJoin(dir, "settings.json"));
    assertEquals(reopened.get("plain"), "1.50");
    assertEquals(reopened.getJson<number>("number"), 1.5);
  } finally {
    await removeDirRetry(dir);
  }
});

// --- createFileSettingsRepo ------------------------------------------------

test("file settings repo: string roundtrip and persistence", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-settings-"));
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
    await removeDirRetry(dir);
  }
});

test("file settings repo: JSON values are stored as strings", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-settings-"));
  const path = join(dir, "settings.jsonc");
  try {
    const repo = createFileSettingsRepo(path);
    repo.setJson("connections", [{ id: "srv-1", name: "自宅" }]);
    repo.set("api_key:anthropic", "sk-test");
    repo.set("theme", "dark");

    const stored = JSON.parse(fsSync.readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    // Strings on disk, so a value like "1.50" is not read back as 1.5.
    assertEquals(stored.connections, '[{"id":"srv-1","name":"自宅"}]');
    assertEquals(stored["api_key:anthropic"], "sk-test");
    assertEquals(stored.theme, "dark");
    // Values read back exactly as they were set.
    assertEquals(repo.get("connections"), '[{"id":"srv-1","name":"自宅"}]');
  } finally {
    await removeDirRetry(dir);
  }
});

test("file settings repo: missing file means empty settings", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-settings-"));
  const path = join(dir, "nested", "settings.jsonc");
  try {
    const repo = createFileSettingsRepo(path);
    assertEquals(repo.list().size, 0);
    repo.set("theme", "light"); // creates the parent directory
    assertEquals(createFileSettingsRepo(path).get("theme"), "light");
  } finally {
    await removeDirRetry(dir);
  }
});

test("file settings repo: malformed file fails fast with its path", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-settings-"));
  const path = join(dir, "settings.jsonc");
  try {
    fsSync.writeFileSync(path, '{ "theme": ,}');
    assertThrows(() => createFileSettingsRepo(path), SettingsFileError, path);
  } finally {
    await removeDirRetry(dir);
  }
});

test("file settings repo: non-object top level is rejected", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-settings-"));
  const path = join(dir, "settings.jsonc");
  try {
    fsSync.writeFileSync(path, "[1, 2, 3]");
    assertThrows(
      () => createFileSettingsRepo(path),
      SettingsFileError,
      "must contain a JSON object",
    );
  } finally {
    await removeDirRetry(dir);
  }
});

// --- createInMemorySettingsRepo ---------------------------------------------

test("in-memory settings repo: basic roundtrip", () => {
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

// --- dir() -------------------------------------------------------------------

test("file settings repo exposes its directory; in-memory has none", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-settings-"));
  try {
    const path = join(dir, "nested", "settings.jsonc");
    const repo = createFileSettingsRepo(path);
    assertEquals(repo.dir(), join(dir, "nested"));
    assertEquals(createInMemorySettingsRepo().dir(), undefined);
  } finally {
    await removeDirRetry(dir);
  }
});

// --- resolveSettingsPath ----------------------------------------------------

test("resolveSettingsPath honors XDG_CONFIG_HOME", () => {
  // The environment is passed in, never mutated: process.env is shared by every
  // test file the runner parallels.
  assertEquals(
    resolveSettingsPath(() => ({ XDG_CONFIG_HOME: join("C:", "xdg") })),
    join("C:", "xdg", "lumisca-agent", "settings.jsonc"),
  );
});

test("resolveSettingsPath defaults to ~/.config", () => {
  assertEquals(
    resolveSettingsPath(() => ({ HOME: join("C:", "users", "me") })),
    join("C:", "users", "me", ".config", "lumisca-agent", "settings.jsonc"),
  );
  // Windows resolves the home directory from USERPROFILE.
  assertEquals(
    resolveSettingsPath(() => ({ USERPROFILE: join("C:", "Users", "me") })),
    join("C:", "Users", "me", ".config", "lumisca-agent", "settings.jsonc"),
  );
  // Neither set: the path cannot be resolved, and that is an error rather
  // than a path under the current directory.
  assertThrows(
    () => resolveSettingsPath(() => ({})),
    Error,
    "Cannot resolve the home directory",
  );
});

test("file settings repo: an external edit survives the next write", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-settings-"));
  const path = join(dir, "settings.jsonc");
  try {
    const repo = createFileSettingsRepo(path);
    repo.set("theme", "dark");

    // The user edits the running app's settings file by hand (the module
    // documents it as hand-editable). The next UI-driven write must not
    // erase that edit.
    fsSync.writeFileSync(
      path,
      `${JSON.stringify({ theme: "dark", language: "ja" }, null, 2)}\n`,
    );
    repo.set("model_fast", "openai/gpt-x");

    const stored = JSON.parse(fsSync.readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    assertEquals(stored.language, "ja", "the hand edit must survive");
    assertEquals(stored.model_fast, "openai/gpt-x");
    assertEquals(stored.theme, "dark");
    // The in-memory view is in step with the file, not stale.
    assertEquals(repo.get("language"), "ja");
  } finally {
    await removeDirRetry(dir);
  }
});
