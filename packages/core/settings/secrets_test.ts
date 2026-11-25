import { test } from "bun:test";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import type { EnvReader } from "../models/custom.ts";
import { removeDirRetry } from "../test-utils.ts";
import { createFileSettingsRepo, createInMemorySettingsRepo } from "./repo.ts";
import {
  CREDENTIALS_DIRECTORY_ENV,
  CREDENTIALS_KEY_FILENAME,
  createEncryptedSettingsRepo,
  createSecretBox,
  isSecretSettingsKey,
  migratePlaintextSecrets,
  parseSecretKey,
  resolveMasterKey,
  SECRET_CIPHER_PREFIX,
  SECRET_KEY_BYTES,
  SECRET_KEY_ENV,
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILENAME,
} from "./secrets.ts";

/** A 32-byte key with a recognizable byte pattern. */
function keyOf(byte: number): Uint8Array {
  return new Uint8Array(SECRET_KEY_BYTES).fill(byte);
}

function envOf(values: Record<string, string>): EnvReader {
  return () => values;
}

/** Assert the POSIX mode bits that keep a key file private. Windows has no
 * such bits: the file lives under the user's profile, where its ACL already
 * limits access, so there is nothing to assert there. */
function assertOwnerOnly(path: string): void {
  if (process.platform === "win32") return;
  assertEquals(fsSync.statSync(path).mode & 0o777, 0o600);
}

/** A fresh settings directory for one test, removed on drop. */
async function withSettingsDir(
  fn: (dir: string, path: string) => Promise<void>,
): Promise<void> {
  const dir = await fsp.mkdtemp(join(osTmpdir(), "lumisca-secrets-"));
  try {
    await fn(dir, join(dir, "settings.jsonc"));
  } finally {
    await removeDirRetry(dir);
  }
}

// --- the cipher --------------------------------------------------------------

test("secret box: roundtrip produces enc.v1 and reads back exactly", () => {
  const box = createSecretBox(keyOf(7));
  const stored = box.encrypt("api_key:anthropic", "sk-test-日本語");
  assertEquals(stored.startsWith(SECRET_CIPHER_PREFIX), true);
  assertEquals(stored.includes("sk-test"), false);
  assertEquals(box.decrypt("api_key:anthropic", stored), "sk-test-日本語");
});

test("secret box: the setting key is authenticated, so a moved ciphertext fails", () => {
  const box = createSecretBox(keyOf(7));
  const stored = box.encrypt("api_key:anthropic", "sk-test");
  assertEquals(box.decrypt("api_key:openai", stored), undefined);
});

test("secret box: another key and a tampered value fail to decrypt", () => {
  const stored = createSecretBox(keyOf(7)).encrypt("api_key:anthropic", "sk");
  assertEquals(
    createSecretBox(keyOf(8)).decrypt("api_key:anthropic", stored),
    undefined,
  );
  const tampered = stored.slice(0, -1) + (stored.endsWith("A") ? "B" : "A");
  assertEquals(
    createSecretBox(keyOf(7)).decrypt("api_key:anthropic", tampered),
    undefined,
  );
});

test("secret box: plain text is not accepted as ciphertext", () => {
  const box = createSecretBox(keyOf(7));
  assertEquals(box.decrypt("api_key:anthropic", "sk-test"), undefined);
});

test("secret box: a key of the wrong length is refused", () => {
  assertThrows(() => createSecretBox(new Uint8Array(16)), Error, "32 bytes");
});

test("parseSecretKey: base64 and base64url both work, whitespace is ignored", () => {
  const key = keyOf(9);
  const base64 = Buffer.from(key).toString("base64");
  const base64url = Buffer.from(key).toString("base64url");
  assertEquals([...parseSecretKey(base64, "env")], [...key]);
  assertEquals([...parseSecretKey(` ${base64url}\n`, "env")], [...key]);
});

test("parseSecretKey: text that is not 32 bytes is refused with its source", () => {
  assertThrows(
    () => parseSecretKey("not base64 at all!", "LUMISCA_SECRET_KEY"),
    Error,
    "LUMISCA_SECRET_KEY",
  );
  assertThrows(
    () => parseSecretKey(Buffer.from("short").toString("base64"), "file.key"),
    Error,
    "32 bytes",
  );
});

// --- which settings are secret ----------------------------------------------

test("the secret key list covers credentials and capability holders", () => {
  assertEquals(isSecretSettingsKey("api_key:anthropic"), true);
  assertEquals(isSecretSettingsKey("mcp_oauth:https://example.test"), true);
  assertEquals(isSecretSettingsKey("mcp_servers"), true);
  assertEquals(isSecretSettingsKey("web_search"), true);
  assertEquals(isSecretSettingsKey("connections"), true);
  assertEquals(isSecretSettingsKey("user_providers"), true);
  assertEquals(isSecretSettingsKey("computer_use_session_token"), true);
  assertEquals(isSecretSettingsKey("push_vapid"), true);
  assertEquals(isSecretSettingsKey("push_subscriptions"), true);
  assertEquals(isSecretSettingsKey("theme"), false);
  assertEquals(isSecretSettingsKey("language"), false);
});

// --- the decorator -----------------------------------------------------------

test("encrypted repo: secret entries are ciphertext at rest and plain in memory", () => {
  const inner = createInMemorySettingsRepo();
  const repo = createEncryptedSettingsRepo(inner, createSecretBox(keyOf(3)));
  repo.set("theme", "dark");
  repo.set("api_key:anthropic", "sk-test");

  const raw = inner.list();
  assertEquals(raw.get("theme"), "dark");
  assertEquals(
    raw.get("api_key:anthropic")?.startsWith(SECRET_CIPHER_PREFIX),
    true,
  );
  assertEquals(raw.get("api_key:anthropic")?.includes("sk-test"), false);

  assertEquals(repo.get("api_key:anthropic"), "sk-test");
  assertEquals(repo.list().get("api_key:anthropic"), "sk-test");
  assertEquals(repo.get("theme"), "dark");
});

test("encrypted repo: JSON secrets round-trip through getJson", () => {
  const repo = createEncryptedSettingsRepo(
    createInMemorySettingsRepo(),
    createSecretBox(keyOf(3)),
  );
  repo.setJson("web_search", { providers: { brave: { apiKey: "k" } } });
  assertEquals(repo.getJson("web_search"), {
    providers: { brave: { apiKey: "k" } },
  });
  assertEquals(repo.dir(), undefined);
});

test("encrypted repo: legacy plaintext is readable until it is migrated", () => {
  const inner = createInMemorySettingsRepo();
  inner.set("api_key:anthropic", "legacy");
  const repo = createEncryptedSettingsRepo(inner, createSecretBox(keyOf(3)));
  assertEquals(repo.get("api_key:anthropic"), "legacy");
  assertEquals(repo.list().get("api_key:anthropic"), "legacy");
});

test("encrypted repo: an undecryptable value reads as unset, others survive", () => {
  const inner = createInMemorySettingsRepo();
  inner.set(
    "api_key:anthropic",
    createSecretBox(keyOf(4)).encrypt("api_key:anthropic", "sk"),
  );
  const repo = createEncryptedSettingsRepo(inner, createSecretBox(keyOf(5)));
  assertEquals(repo.get("api_key:anthropic"), undefined);
  assertEquals(repo.list().has("api_key:anthropic"), false);
});

test("encrypted repo: delete reaches the underlying store", () => {
  const inner = createInMemorySettingsRepo();
  const repo = createEncryptedSettingsRepo(inner, createSecretBox(keyOf(3)));
  repo.set("api_key:anthropic", "sk");
  repo.delete("api_key:anthropic");
  assertEquals(inner.get("api_key:anthropic"), undefined);
});

// --- migration ---------------------------------------------------------------

test("migration: plaintext secrets are encrypted once and stay readable", () => {
  const inner = createInMemorySettingsRepo();
  inner.set("api_key:anthropic", "sk-test");
  inner.set("mcp_oauth:https://example.test", JSON.stringify({ token: "t" }));
  inner.set("theme", "dark");

  const box = createSecretBox(keyOf(3));
  const repo = createEncryptedSettingsRepo(inner, box);
  assertEquals(migratePlaintextSecrets(inner, box), 2);
  assertEquals(
    inner.get("api_key:anthropic")?.startsWith(SECRET_CIPHER_PREFIX),
    true,
  );
  assertEquals(inner.get("theme"), "dark");
  assertEquals(repo.get("api_key:anthropic"), "sk-test");
  assertEquals(migratePlaintextSecrets(inner, box), 0);
});

test("migration: a ciphertext under another key is left alone", () => {
  const inner = createInMemorySettingsRepo();
  const foreign = createSecretBox(keyOf(4)).encrypt("api_key:anthropic", "sk");
  inner.set("api_key:anthropic", foreign);
  const box = createSecretBox(keyOf(5));
  const repo = createEncryptedSettingsRepo(inner, box);
  assertEquals(migratePlaintextSecrets(inner, box), 0);
  assertEquals(repo.get("api_key:anthropic"), undefined);
  assertEquals(inner.get("api_key:anthropic"), foreign);
});

// --- key resolution ----------------------------------------------------------

test("key resolution: a captured key wins over the environment", async () => {
  await withSettingsDir(async (dir) => {
    const resolved = resolveMasterKey(
      dir,
      envOf({ [SECRET_KEY_ENV]: Buffer.from(keyOf(1)).toString("base64") }),
      Buffer.from(keyOf(2)).toString("base64"),
    );
    assertEquals(resolved.source, "env");
    assertEquals(resolved.key[0], 2);
  });
});

test("key resolution: LUMISCA_SECRET_KEY wins over every file", async () => {
  await withSettingsDir(async (dir) => {
    fsSync.writeFileSync(
      join(dir, SECRET_KEY_FILENAME),
      Buffer.from(keyOf(1)).toString("base64"),
    );
    const resolved = resolveMasterKey(
      dir,
      envOf({
        [SECRET_KEY_ENV]: Buffer.from(keyOf(2)).toString("base64"),
      }),
    );
    assertEquals(resolved.source, "env");
    assertEquals(resolved.key[0], 2);
  });
});

test("key resolution: a systemd credential is used when the file is there", async () => {
  await withSettingsDir(async (dir) => {
    const credentials = join(dir, "credentials");
    fsSync.mkdirSync(credentials);
    fsSync.writeFileSync(
      join(credentials, CREDENTIALS_KEY_FILENAME),
      Buffer.from(keyOf(3)).toString("base64"),
    );
    const resolved = resolveMasterKey(
      dir,
      envOf({
        [CREDENTIALS_DIRECTORY_ENV]: credentials,
      }),
    );
    assertEquals(resolved.source, "credentials");
    assertEquals(resolved.key[0], 3);
  });
});

test("key resolution: an explicit file is created with mode 0600", async () => {
  await withSettingsDir(async (dir) => {
    const path = join(dir, "keys", "master.key");
    const resolved = resolveMasterKey(
      dir,
      envOf({ [SECRET_KEY_FILE_ENV]: path }),
    );
    assertEquals(resolved.source, "key-file");
    assertEquals(fsSync.existsSync(path), true);
    assertOwnerOnly(path);
    assertEquals(fsSync.readFileSync(path, "utf8").trim().length > 0, true);

    const again = resolveMasterKey(dir, envOf({ [SECRET_KEY_FILE_ENV]: path }));
    assertEquals([...again.key], [...resolved.key]);
  });
});

test("key resolution: the settings directory gets a key file on first use", async () => {
  await withSettingsDir(async (dir) => {
    const resolved = resolveMasterKey(dir, envOf({}));
    assertEquals(resolved.source, "settings-key-file");
    assertEquals(resolved.location, join(dir, SECRET_KEY_FILENAME));
    assertOwnerOnly(join(dir, SECRET_KEY_FILENAME));

    const again = resolveMasterKey(dir, envOf({}));
    assertEquals([...again.key], [...resolved.key]);
  });
});

test("key resolution: no directory means a per-process key", () => {
  const a = resolveMasterKey(undefined, envOf({}));
  const b = resolveMasterKey(undefined, envOf({}));
  assertEquals(a.source, "ephemeral");
  assertEquals(b.source, "ephemeral");
  assertNotEquals(
    Buffer.from(a.key).toString("base64"),
    Buffer.from(b.key).toString("base64"),
  );
});

test("key resolution: an unreadable key file fails with its path", async () => {
  await withSettingsDir(async (dir) => {
    const path = join(dir, "bad.key");
    fsSync.writeFileSync(path, "not a key");
    assertThrows(
      () => resolveMasterKey(dir, envOf({ [SECRET_KEY_FILE_ENV]: path })),
      Error,
      path,
    );
  });
});

// --- file-backed integration -------------------------------------------------

test("file-backed settings: migration rewrites the file, not just memory", async () => {
  await withSettingsDir(async (dir, path) => {
    fsSync.writeFileSync(
      path,
      JSON.stringify({
        "api_key:anthropic": '{"type":"api_key","key":"sk-test"}',
        theme: "dark",
      }),
    );
    const box = createSecretBox(keyOf(6));
    const store = createFileSettingsRepo(path);
    assertEquals(migratePlaintextSecrets(store, box), 1);
    const repo = createEncryptedSettingsRepo(store, box);

    const onDisk = JSON.parse(fsSync.readFileSync(path, "utf8")) as Record<
      string,
      string
    >;
    const storedKey = onDisk["api_key:anthropic"] ?? "";
    assertEquals(storedKey.startsWith(SECRET_CIPHER_PREFIX), true);
    assertEquals(onDisk.theme, "dark");
    assertEquals(
      repo.get("api_key:anthropic"),
      '{"type":"api_key","key":"sk-test"}',
    );

    // A new repo with the same key reads the same value.
    const reopened = createEncryptedSettingsRepo(
      createFileSettingsRepo(path),
      createSecretBox(keyOf(6)),
    );
    assertEquals(
      reopened.get("api_key:anthropic"),
      '{"type":"api_key","key":"sk-test"}',
    );
  });
});
