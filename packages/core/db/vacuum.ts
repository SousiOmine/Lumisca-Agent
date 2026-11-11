/**
 * Reclaiming the space a long conversation freed.
 *
 * A conversation that runs for years adds tool output and pictures to
 * messages, and compaction plus pruning (session/prune.ts) replace most of
 * that with markers. The ROWS shrink, but a SQLite database does not hand
 * the freed pages back: they are reused by later writes (so the file stops
 * growing), while the file itself stays the size of its high-water mark.
 *
 * **Why the rows are copied instead of vacuumed.** SQLite's own `VACUUM`
 * (and `VACUUM INTO`) needs a second database connection, and the runtime
 * this app uses (`node:sqlite`) is built with `SQLITE_MAX_ATTACHED=0` — both
 * forms fail with "too many attached databases - max 0". So the rewrite is
 * done here: a fresh file is created with the schema, every row is copied
 * into it, and the result replaces the original in one rename. That is what
 * `VACUUM` does internally anyway (rebuild from a fresh file), with the
 * reader being this process instead of SQLite's own.
 *
 * It is a STARTUP operation and nothing else. The copy of a large database
 * takes minutes and blocks the event loop, and a running server cannot pause
 * for that: every request would stall. So it runs once, before the first
 * request is served, and only when the previous run recorded enough freed
 * bytes to be worth the wait (see requestVacuum).
 */

import { rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";

const log = createLogger("vacuum");

/** Freed bytes below this are not worth a rewrite: a database of a few
 * megabytes is rewritten in well under a second, but it is also not the
 * database this exists for. */
export const MIN_VACUUM_BYTES = 64 * 1024 * 1024;

/** The sidecar beside the database holding "a rewrite is due".
 *
 * `basename` is the path module's, not a hunt for the last `/`: a Windows
 * path is separated by `\`, and a hand-written split left the drive and the
 * whole directory list in the name (`C:\...\l.db.vacuum`), which Windows
 * refuses to create — the marker never existed there, and every test that
 * wrote one failed with "The filename, directory name, or volume label
 * syntax is incorrect".
 */
export function vacuumMarkerPath(dbPath: string): string {
  return join(dirname(dbPath), `${basename(dbPath)}.vacuum`);
}

/**
 * Rewrite the database file when a previous run asked for it.
 *
 * Called before the database is opened for serving. The marker holds the
 * number of bytes the last run believed it freed; a marker below the
 * threshold is dropped without touching anything, so a conversation that
 * only grew slightly costs nothing.
 *
 * A failure is never fatal: the server starts on the database it already
 * has, and the marker is left so the next start tries again (a full disk is
 * the ordinary reason, and it is not a reason to refuse to run).
 */
export async function vacuumOnStartup(dbPath: string): Promise<void> {
  const marker = vacuumMarkerPath(dbPath);
  let due: number;
  try {
    due = Number((await Deno.readTextFile(marker)).trim());
  } catch {
    // No marker: nothing was requested (the ordinary case).
    return;
  }
  if (!Number.isFinite(due) || due < MIN_VACUUM_BYTES) {
    await rm(marker, { force: true });
    return;
  }
  const copy = `${dbPath}.vacuum-copy`;
  const startedAt = performance.now();
  try {
    await rm(copy, { force: true });
    copyDatabase(dbPath, copy);
    const before = (await stat(dbPath)).size;
    const after = (await stat(copy)).size;
    // The copy is complete and closed, so replacing the original is one
    // rename. The -wal/-shm files belong to the old file and go with it.
    await rename(copy, dbPath);
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    log.info(
      `database rewritten on startup: ${formatMiB(before)} → ${formatMiB(
        after,
      )} in ${Math.round(performance.now() - startedAt)} ms`,
    );
    await rm(marker, { force: true });
  } catch (error) {
    // Left for the next start: a full disk is the usual cause, and it must
    // not stop the server from running on the database it already has.
    log.warn(
      `startup database rewrite skipped: ${errorMessage(error)} ` +
        "(the database was not touched)",
    );
    await rm(copy, { force: true }).catch(() => {});
  }
}

/** Copy every row of every table into a fresh file with the same shape.
 *
 * The tables come from `sqlite_master` in creation order (the migrations
 * create parents before children, which is the order the foreign keys need),
 * and each table's own `CREATE` statement is replayed into the target — the
 * source is the authority on its own schema, so the copy works for any
 * database this build can read, not just one built by the current
 * migrations. */
function copyDatabase(from: string, to: string): void {
  const source = new DatabaseSync(from);
  let target: DatabaseSync | undefined;
  try {
    target = new DatabaseSync(to);
    target.exec("PRAGMA journal_mode = WAL;");
    target.exec("PRAGMA foreign_keys = OFF;");
    // One transaction for the whole copy: a half-written database must never
    // be promoted (the caller renames only after this returns). Foreign keys
    // stay off while it runs: creation order already matches the references,
    // and a table copied before its parent must not be refused.
    target.exec("BEGIN IMMEDIATE");
    try {
      for (const { name, sql } of tablesOf(source, "table")) {
        if (sql !== null) target.exec(sql);
        const rows = source.prepare(`SELECT * FROM "${name}"`).all() as Array<
          Record<string, unknown>
        >;
        if (rows.length === 0) continue;
        const columns = Object.keys(rows[0]!);
        const insert = target.prepare(
          `INSERT INTO "${name}" (${columns
            .map((column) => `"${column}"`)
            .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        );
        for (const row of rows) {
          insert.run(...columns.map((column) => row[column] as never));
        }
      }
      // Indexes are replayed after the rows: building them once is faster
      // than maintaining them during the copy.
      for (const { name, sql } of tablesOf(source, "index")) {
        if (sql === null || name.startsWith("sqlite_autoindex")) continue;
        target.exec(sql);
      }
      // The schema version travels with the data: a copy that claimed an
      // older version would be migrated again on the next open.
      const { user_version: version } = source
        .prepare("PRAGMA user_version")
        .get() as { user_version: number };
      target.exec(`PRAGMA user_version = ${version}`);
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    target?.close();
    source.close();
  }
}

/** The objects of one kind in the database, in creation order. */
function tablesOf(
  db: DatabaseSync,
  type: "table" | "index",
): Array<{ name: string; sql: string | null }> {
  return db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = ? " +
        "AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all(type) as Array<{ name: string; sql: string | null }>;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
