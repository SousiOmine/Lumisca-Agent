import type { Database } from "bun:sqlite";

/** Run `fn` as one transaction. A nested call uses a SAVEPOINT, so a
 * repository helper can be called from another transaction without committing
 * half of it. The callback must be synchronous: the connection is Bun's
 * synchronous SQLite handle, and a promise would commit before it settled.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front. A deferred transaction
 * that reads and then writes can fail with SQLITE_BUSY halfway through, which
 * is exactly the partial state this helper exists to prevent. */
export function inTransaction<T>(db: Database, fn: () => T): T {
  const depth = ((db as Database & { __lumisca_tx?: number }).__lumisca_tx ??=
    0);
  const savepoint = depth > 0 ? `lumisca_sp_${depth}` : null;
  if (savepoint === null) db.exec("BEGIN IMMEDIATE");
  else db.exec(`SAVEPOINT ${savepoint}`);
  (db as Database & { __lumisca_tx?: number }).__lumisca_tx = depth + 1;
  try {
    const result = fn();
    if (savepoint === null) db.exec("COMMIT");
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    if (savepoint === null) db.exec("ROLLBACK");
    else {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    }
    throw error;
  } finally {
    (db as Database & { __lumisca_tx?: number }).__lumisca_tx = depth;
  }
}
