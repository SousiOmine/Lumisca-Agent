import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "./schema.ts";

/** Central SQLite access point. All repositories share one instance. */
export class LumiscaDb {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): LumiscaDb {
    const db = new DatabaseSync(path);
    const lumisca = new LumiscaDb(db);
    lumisca.db.exec("PRAGMA journal_mode = WAL;");
    lumisca.db.exec("PRAGMA foreign_keys = ON;");
    lumisca.db.exec(SCHEMA);
    return lumisca;
  }

  static openInMemory(): LumiscaDb {
    const db = new DatabaseSync(":memory:");
    const lumisca = new LumiscaDb(db);
    lumisca.db.exec("PRAGMA foreign_keys = ON;");
    lumisca.db.exec(SCHEMA);
    return lumisca;
  }

  close(): void {
    this.db.close();
  }
}
