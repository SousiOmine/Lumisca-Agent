import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { LumiscaDb } from "./mod.ts";

test("a throwing transaction leaves nothing behind", () => {
  const db = LumiscaDb.openInMemory();
  try {
    db.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    assertThrows(() =>
      db.transaction(() => {
        db.db.prepare("INSERT INTO t (v) VALUES (?)").run("a");
        throw new Error("stop");
      }),
    );
    assertEquals(
      db.db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number },
      { n: 0 },
    );
  } finally {
    db.close();
  }
});

test("a nested transaction rolls back to its savepoint", () => {
  const db = LumiscaDb.openInMemory();
  try {
    db.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.transaction(() => {
      db.db.prepare("INSERT INTO t (v) VALUES (?)").run("outer");
      assertThrows(() =>
        db.transaction(() => {
          db.db.prepare("INSERT INTO t (v) VALUES (?)").run("inner");
          throw new Error("stop");
        }),
      );
    });
    assertEquals(
      (db.db.prepare("SELECT v FROM t").all() as Array<{ v: string }>).map(
        (row) => row.v,
      ),
      ["outer"],
    );
  } finally {
    db.close();
  }
});
