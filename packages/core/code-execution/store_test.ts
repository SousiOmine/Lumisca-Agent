import { test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertThrows } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import {
  CODE_STORE_MAX_KEY_CHARS,
  CODE_STORE_MAX_VALUE_BYTES,
  createCodeStoreRepo,
} from "./store.ts";

function insertSession(db: LumiscaDb, id = "s1"): void {
  db.db
    .prepare(
      "INSERT INTO workspaces (id, name, created_at, chat) VALUES (?, ?, ?, 0)",
    )
    .run("w", "w", 0);
  db.db
    .prepare(
      "INSERT INTO sessions " +
        "(id, workspace_id, name, model_provider, model_id, created_at, updated_at) " +
        "VALUES (?, 'w', ?, 'faux', 'm', 0, 0)",
    )
    .run(id, id);
}

test("store: a value round-trips and survives a new transaction", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertSession(db);
    const repo = createCodeStoreRepo(db);
    const store = repo.begin("s1");
    store.set("cursor", { page: 2, tags: ["a", "b"] });
    assertEquals(store.get("cursor"), { page: 2, tags: ["a", "b"] });
    // Another transaction does not see the write until commit.
    assertEquals(repo.begin("s1").get("cursor"), undefined);
    store.commit();
    assertEquals(repo.begin("s1").get("cursor"), {
      page: 2,
      tags: ["a", "b"],
    });
  } finally {
    db.close();
  }
});

test("store: undefined deletes and null is a value", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertSession(db);
    const repo = createCodeStoreRepo(db);
    const store = repo.begin("s1");
    store.set("kept", null);
    store.set("gone", 1);
    store.set("gone", undefined);
    store.commit();
    const next = repo.begin("s1");
    assertEquals(next.get("kept"), null);
    assertEquals(next.get("gone"), undefined);
  } finally {
    db.close();
  }
});

test("store: a failed program's writes never reach the database", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertSession(db);
    const repo = createCodeStoreRepo(db);
    const store = repo.begin("s1");
    store.set("k", 1);
    // No commit: this is what execute does when the program throws.
    assertEquals(repo.begin("s1").get("k"), undefined);
  } finally {
    db.close();
  }
});

test("store: snapshot and changes describe the program's writes", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertSession(db);
    const repo = createCodeStoreRepo(db);
    const store = repo.begin("s1");
    store.set("a", 1);
    store.set("b", { c: 2 });
    store.delete("missing");

    const snapshot = store.snapshot();
    assertEquals(snapshot["a"], 1);
    assertEquals(snapshot["b"], { c: 2 });

    const changes = store.changes();
    assertEquals(changes.set["a"], 1);
    assertEquals(changes.set["b"], { c: 2 });
    assertEquals(changes.delete, []);
  } finally {
    db.close();
  }
});

test("store: apply writes the VM's diff", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertSession(db);
    const repo = createCodeStoreRepo(db);
    const store = repo.begin("s1");
    store.set("old", 1);
    store.commit();

    const vm = repo.begin("s1");
    vm.apply({ set: { added: { ok: true } }, delete: ["old"] });
    vm.commit();

    const next = repo.begin("s1");
    assertEquals(next.get("old"), undefined);
    assertEquals(next.get("added"), { ok: true });
  } finally {
    db.close();
  }
});

test("store: keys and values have bounds", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertSession(db);
    const store = createCodeStoreRepo(db).begin("s1");
    assertThrows(
      () => store.set("x".repeat(CODE_STORE_MAX_KEY_CHARS + 1), 1),
      Error,
      "longer than",
    );
    assertThrows(
      () => store.set("k", "x".repeat(CODE_STORE_MAX_VALUE_BYTES + 1)),
      Error,
      "larger than",
    );
    assertThrows(() => store.set("k", 1n), Error, "JSON");
    assertThrows(() => store.set("k", () => 1), Error, "JSON");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    assertThrows(() => store.set("k", cyclic), Error, "JSON");
  } finally {
    db.close();
  }
});

test("store: the whole session has a bound", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertSession(db);
    const store = createCodeStoreRepo(db).begin("s1");
    const chunk = "x".repeat(250 * 1024);
    for (let index = 0; index < 4; index++) store.set("k" + index, chunk);
    assertThrows(
      () => store.set("last", "y".repeat(30 * 1024)),
      Error,
      "larger",
    );
  } finally {
    db.close();
  }
});

test("store: malformed JSON in a row is reported, not ignored", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertSession(db);
    db.db
      .prepare(
        "INSERT INTO code_store (session_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("s1", "broken", "not json", 0);
    assertThrows(
      () => createCodeStoreRepo(db).begin("s1"),
      Error,
      "not valid JSON",
    );
  } finally {
    db.close();
  }
});

test("store: deleting the session removes its values", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertSession(db);
    const repo = createCodeStoreRepo(db);
    const store = repo.begin("s1");
    store.set("k", 1);
    store.commit();
    db.db.prepare("DELETE FROM sessions WHERE id = ?").run("s1");
    const rows = db.db
      .prepare("SELECT COUNT(*) AS n FROM code_store WHERE session_id = ?")
      .get("s1") as { n: number };
    assertEquals(rows.n, 0);
  } finally {
    db.close();
  }
});

test("store: values survive reopening the database", async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), "lumisca-store-"));
  const path = join(dir, "test.db");
  try {
    const first = LumiscaDb.open(path);
    insertSession(first);
    const store = createCodeStoreRepo(first).begin("s1");
    store.set("cursor", { page: 2 });
    store.commit();
    first.close();

    const second = LumiscaDb.open(path);
    try {
      assertEquals(createCodeStoreRepo(second).begin("s1").get("cursor"), {
        page: 2,
      });
    } finally {
      second.close();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
