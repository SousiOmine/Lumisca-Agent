import { Database } from "bun:sqlite";
import { basename, dirname, join } from "node:path";
import { assertEquals } from "@std/assert";
import { closeDatabase } from "./close.ts";
import { LumiscaDb } from "./mod.ts";
import {
  MIN_VACUUM_BYTES,
  vacuumMarkerPath,
  vacuumOnStartup,
} from "./vacuum.ts";

/** A database file with a table and `rows` blob rows, so the file has a
 * real size to reclaim.
 *
 * One transaction for the whole insert: at 4 KiB per row and 200 rows, an
 * autocommit per row spends seconds on fsync (`sqlite` flushes the WAL on
 * every commit), and this fixture is built by four cases here. */
function makeDatabase(path: string, rows: number): void {
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob BLOB)");
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO t (blob) VALUES (?)");
    for (let i = 0; i < rows; i++) {
      insert.run(new Uint8Array(4096));
    }
    db.exec("COMMIT");
  } finally {
    closeDatabase(db);
  }
}

function sizeOf(path: string): Promise<number> {
  return Deno.stat(path).then((stat) => stat.size);
}

Deno.test("vacuum: the marker sits beside the database on any platform's path", () => {
  // A Windows path is separated by `\`, not `/`. Splitting on `/` alone put
  // the drive and the whole directory list into the marker's name, which
  // Windows cannot create — so a database that pruned enough to ask for a
  // rewrite never got one there, and the freed space was never reclaimed.
  //
  // The path module answers for the CURRENT platform: a POSIX path handed to
  // `dirname` on Windows is one long file name (`/home/me/...`), so only the
  // shapes this OS uses can be asserted. The other separator is covered by
  // `basename` itself, and by this test running on every OS in CI.
  const paths =
    Deno.build.os === "windows"
      ? ["C:\\Users\\me\\AppData\\l.db", "l.db"]
      : ["/home/me/.lumisca/l.db", "l.db"];
  for (const path of paths) {
    const marker = vacuumMarkerPath(path);
    assertEquals(dirname(marker), dirname(path), path);
    assertEquals(basename(marker), `${basename(path)}.vacuum`, path);
  }
});

Deno.test("vacuum: no marker means nothing happens", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-vacuum-" });
  try {
    const path = join(dir, "l.db");
    makeDatabase(path, 10);
    const before = await sizeOf(path);
    await vacuumOnStartup(path);
    assertEquals(await sizeOf(path), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("vacuum: a marker below the threshold is dropped untouched", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-vacuum-" });
  try {
    const path = join(dir, "l.db");
    makeDatabase(path, 10);
    const before = await sizeOf(path);
    // A conversation that grew a little is not worth a restart's delay.
    await Deno.writeTextFile(vacuumMarkerPath(path), "1024");
    await vacuumOnStartup(path);
    assertEquals(await sizeOf(path), before);
    // The marker is gone: it described a request that no longer applies.
    assertEquals(
      await Deno.stat(vacuumMarkerPath(path))
        .then(() => true)
        .catch(() => false),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("vacuum: a due request rewrites the file and keeps its contents", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-vacuum-" });
  try {
    const path = join(dir, "l.db");
    makeDatabase(path, 200);
    // Delete most of the rows: the pages are free but the file stays large,
    // which is exactly the state a prune leaves behind.
    const db = new Database(path);
    db.exec("DELETE FROM t WHERE id > 10");
    closeDatabase(db);
    const before = await sizeOf(path);
    await Deno.writeTextFile(vacuumMarkerPath(path), String(MIN_VACUUM_BYTES));

    await vacuumOnStartup(path);

    const after = await sizeOf(path);
    assertEquals(after < before, true, `${after} should be under ${before}`);
    // Nothing was lost: the surviving rows are still there, and the database
    // opens as an ordinary file.
    const reread = new Database(path);
    try {
      const row = reread.prepare("SELECT COUNT(*) AS n FROM t").get() as {
        n: number;
      };
      assertEquals(Number(row.n), 10);
    } finally {
      closeDatabase(reread);
    }
    // The request was consumed.
    assertEquals(
      await Deno.stat(vacuumMarkerPath(path))
        .then(() => true)
        .catch(() => false),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("vacuum: a failed rewrite leaves the database usable and the marker in place", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-vacuum-" });
  try {
    const path = join(dir, "l.db");
    makeDatabase(path, 20);
    await Deno.writeTextFile(vacuumMarkerPath(path), String(MIN_VACUUM_BYTES));
    // A directory where the copy must go: the copy fails, and that must not
    // damage the original (a full disk is the ordinary cause).
    await Deno.mkdir(`${path}.vacuum-copy`);

    await vacuumOnStartup(path);

    const db = new Database(path);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM t").get() as {
        n: number;
      };
      assertEquals(Number(row.n), 20);
    } finally {
      closeDatabase(db);
    }
    // Left for the next start.
    assertEquals(
      await Deno.readTextFile(vacuumMarkerPath(path)),
      String(MIN_VACUUM_BYTES),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("vacuum: a real database keeps its schema version, indexes and rows", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-vacuum-" });
  try {
    const path = join(dir, "lumisca.db");
    // A database this build creates: migrations, indexes and all.
    const original = LumiscaDb.open(path);
    original.db
      .prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 't', 0)",
      )
      .run();
    original.db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
       VALUES ('s1', 'w1', 'n', 'p', 'm', 0, 0)`,
      )
      .run();
    original.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, timestamp)
       VALUES ('m1', 's1', 'user', '{}', 1)`,
      )
      .run();
    const version = (
      original.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version;
    original.close();

    await Deno.writeTextFile(vacuumMarkerPath(path), String(MIN_VACUUM_BYTES));
    await vacuumOnStartup(path);

    // Opening it migrates nothing (the version travelled) and the rows are
    // all there.
    const reread = LumiscaDb.open(path);
    try {
      const row = reread.db
        .prepare("SELECT COUNT(*) AS n FROM messages")
        .get() as { n: number };
      assertEquals(Number(row.n), 1);
      const stamped = (
        reread.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version;
      assertEquals(stamped, version);
      // The indexes came across, which is what paging and the checkpoint
      // lookup rely on.
      const indexes = reread.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' " +
            "AND name = 'idx_messages_checkpoint'",
        )
        .all();
      assertEquals(indexes.length, 1);
    } finally {
      reread.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
