import type { LumiscaDb } from "../db/mod.ts";
export { THEME_KEY } from "../shared.ts";

export interface SettingsRepo {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  list(): Map<string, string>;
}

export function createSettingsRepo(db: LumiscaDb): SettingsRepo {
  const getStmt = db.db.prepare("SELECT value FROM settings WHERE key = ?");
  const setStmt = db.db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const deleteStmt = db.db.prepare("DELETE FROM settings WHERE key = ?");
  const listStmt = db.db.prepare("SELECT key, value FROM settings");

  return {
    get(key: string): string | undefined {
      const row = getStmt.get(key) as { value: string } | undefined;
      return row?.value;
    },
    set(key: string, value: string): void {
      setStmt.run(key, value);
    },
    delete(key: string): void {
      deleteStmt.run(key);
    },
    list(): Map<string, string> {
      const rows = listStmt.all() as Array<{ key: string; value: string }>;
      return new Map(rows.map((r) => [r.key, r.value]));
    },
  };
}
