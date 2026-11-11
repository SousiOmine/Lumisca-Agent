import { Database } from "bun:sqlite";
import { closeDatabase } from "./close.ts";
import { migrate } from "./schema.ts";

/** Central SQLite access point. All repositories share one instance. */
export class LumiscaDb {
  readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static open(path: string): LumiscaDb {
    const db = new Database(path);
    const lumisca = new LumiscaDb(db);
    lumisca.db.exec("PRAGMA journal_mode = WAL;");
    lumisca.db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    return lumisca;
  }

  static openInMemory(): LumiscaDb {
    const db = new Database(":memory:");
    const lumisca = new LumiscaDb(db);
    lumisca.db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    return lumisca;
  }

  close(): void {
    closeDatabase(this.db);
  }
}
