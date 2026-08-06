import type { LumiscaDb } from "../db/mod.ts";
import type { Workspace } from "../types/workspace.ts";

export interface WorkspaceRepo {
  create(name: string, folders: string[], createdAt?: number): Workspace;
  get(id: string): Workspace | undefined;
  list(): Workspace[];
  update(id: string, name: string, folders: string[]): void;
  delete(id: string): void;
}

function toWorkspace(row: {
  id: string;
  name: string;
  created_at: number;
}, folders: string[]): Workspace {
  return { id: row.id, name: row.name, folders, createdAt: row.created_at };
}

export function createWorkspaceRepo(db: LumiscaDb): WorkspaceRepo {
  const insertStmt = db.db.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
  );
  const insertFolderStmt = db.db.prepare(
    "INSERT INTO workspace_folders (workspace_id, path) VALUES (?, ?)",
  );
  const getStmt = db.db.prepare(
    "SELECT id, name, created_at FROM workspaces WHERE id = ?",
  );
  const listStmt = db.db.prepare(
    "SELECT id, name, created_at FROM workspaces ORDER BY created_at DESC",
  );
  const foldersStmt = db.db.prepare(
    "SELECT path FROM workspace_folders WHERE workspace_id = ? ORDER BY rowid",
  );
  const deleteFoldersStmt = db.db.prepare(
    "DELETE FROM workspace_folders WHERE workspace_id = ?",
  );
  const renameStmt = db.db.prepare(
    "UPDATE workspaces SET name = ? WHERE id = ?",
  );
  const deleteStmt = db.db.prepare("DELETE FROM workspaces WHERE id = ?");

  return {
    create(name, folders, createdAt = Date.now()): Workspace {
      const id = crypto.randomUUID();
      insertStmt.run(id, name, createdAt);
      for (const folder of folders) {
        insertFolderStmt.run(id, folder);
      }
      return toWorkspace({ id, name, created_at: createdAt }, folders);
    },

    get(id: string): Workspace | undefined {
      const row = getStmt.get(id) as
        | { id: string; name: string; created_at: number }
        | undefined;
      if (!row) return undefined;
      const folders = (foldersStmt.all(id) as Array<{ path: string }>).map(
        (f) => f.path,
      );
      return toWorkspace(row, folders);
    },

    list(): Workspace[] {
      const rows = listStmt.all() as Array<{
        id: string;
        name: string;
        created_at: number;
      }>;
      return rows.map((row) => {
        const folders = (foldersStmt.all(row.id) as Array<{ path: string }>)
          .map((f) => f.path);
        return toWorkspace(row, folders);
      });
    },

    update(id: string, name: string, folders: string[]): void {
      renameStmt.run(name, id);
      deleteFoldersStmt.run(id);
      for (const folder of folders) {
        insertFolderStmt.run(id, folder);
      }
    },

    delete(id: string): void {
      deleteStmt.run(id);
    },
  };
}
