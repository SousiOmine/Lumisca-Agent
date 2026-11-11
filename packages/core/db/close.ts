import type { Database } from "bun:sqlite";

/**
 * Close a database and release its file.
 *
 * Bun's SQLite keeps the database file open until every prepared statement
 * is finalized, and Windows refuses to rename or delete an open file: the
 * startup vacuum renames the database it just copied, and a test that
 * deletes its temporary folder after closing one hits the same lock
 * (EBUSY). `close(true)` finalizes the statements first; a bare `close()`
 * leaves them to the collector, which is too late for both. `node:sqlite`
 * has no equivalent, which is why the database layer uses `bun:sqlite`.
 */
export function closeDatabase(db: Database): void {
  db.close(true);
}
