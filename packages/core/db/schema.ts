import type { Database } from "bun:sqlite";
import { migrations1to6 } from "./migrations/1to6.ts";
import { migrations7to12 } from "./migrations/7to12.ts";
import { migrations13to18 } from "./migrations/13to18.ts";
import { migrations19to23 } from "./migrations/19to23.ts";

/** Ordered schema migrations. Index i brings the DB from user_version i to
 * i+1; appending a new migration is the only thing needed to evolve the
 * schema of existing databases. Exported for the test that applies all but
 * the last one, inserts a row, and checks what the last one does to it. */
export const MIGRATIONS: ReadonlyArray<(db: Database) => void> = [
  ...migrations1to6,
  ...migrations7to12,
  ...migrations13to18,
  ...migrations19to23,
];

/** The `user_version` a fully migrated database carries: one per migration
 * applied. Exposed so tests assert the invariant ("the stamp matches the
 * migration list") instead of a literal that every new migration breaks. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Apply pending migrations, tracked via PRAGMA user_version.
 *
 * Each migration runs in its own transaction WITH its stamp, so a process
 * killed mid-migration leaves the database at the previous version instead
 * of half-migrated. That matters because the ALTERs are not idempotent: a
 * column added without its stamp would make the retried migration fail with
 * `duplicate column name`, and the database could never be opened again. */
export function migrate(db: Database): void {
  applyMigrations(db, MIGRATIONS);
}

/** A migration that would leave a row pointing at a row that is not there
 * fails here, before its stamp is written. */
function assertForeignKeys(db: Database): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all() as Array<{
    table: string;
    rowid: number;
    parent: string;
  }>;
  const first = violations[0];
  if (first === undefined) return;
  throw new Error(
    `migration left a dangling reference: ${first.table} row ${first.rowid} → ${first.parent}`,
  );
}

/** Apply a migration list. Split from {@link migrate} so a test can drive a
 * deliberately failing migration and observe the rollback, which is the
 * property that keeps a half-done database openable. */
export function applyMigrations(
  db: Database,
  migrations: ReadonlyArray<(db: Database) => void>,
): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  // Foreign keys are off for the run, and every step is checked before its
  // commit. A table rebuild (the only way to add a reference or drop a
  // constraint in SQLite) would otherwise cascade into the child rows when
  // the old table is dropped — a transcript's messages go with it — and a
  // rebuild that would leave a row pointing at nothing rolls back instead of
  // landing. The check is what keeps the promise the old `foreign_keys = ON`
  // made: a migration cannot commit a broken reference.
  const { foreign_keys: wasEnabled } = db
    .prepare("PRAGMA foreign_keys")
    .get() as { foreign_keys: number };
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (let v = current; v < migrations.length; v++) {
      db.exec("BEGIN IMMEDIATE");
      try {
        migrations[v]!(db);
        assertForeignKeys(db);
        // PRAGMA user_version cannot take a bound parameter, and the value is
        // this module's own integer (never user input).
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (wasEnabled === 1) db.exec("PRAGMA foreign_keys = ON");
  }
}
