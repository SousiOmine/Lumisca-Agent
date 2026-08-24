import type { LumiscaDb } from "../db/mod.ts";
import type { Workspace } from "../types/workspace.ts";

/** Extra creation options of a workspace row. Kept as an options object so
 * callers never mix positional boolean/number arguments. */
export interface WorkspaceCreateOptions {
  /** True for the folder-less "simple chat" workspace (an internal
   * singleton; not user-manageable, hidden from the public list). */
  chat?: boolean;
  /** Creation timestamp (defaults to now). */
  createdAt?: number;
}

export interface WorkspaceRepo {
  create(
    name: string,
    folders: string[],
    options?: WorkspaceCreateOptions,
  ): Workspace;
  get(id: string): Workspace | undefined;
  list(): Workspace[];
  update(id: string, name: string, folders: string[]): void;
  delete(id: string): void;
}

function toWorkspace(row: {
  id: string;
  name: string;
  created_at: number;
  chat: number;
}, folders: string[]): Workspace {
  return {
    id: row.id,
    name: row.name,
    folders,
    createdAt: row.created_at,
    chat: row.chat === 1,
  };
}

export function createWorkspaceRepo(db: LumiscaDb): WorkspaceRepo {
  const insertStmt = db.db.prepare(
    "INSERT INTO workspaces (id, name, chat, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertFolderStmt = db.db.prepare(
    "INSERT INTO workspace_folders (workspace_id, path) VALUES (?, ?)",
  );
  const getStmt = db.db.prepare(
    "SELECT id, name, chat, created_at FROM workspaces WHERE id = ?",
  );
  const listStmt = db.db.prepare(
    "SELECT id, name, chat, created_at FROM workspaces ORDER BY created_at DESC",
  );
  const foldersStmt = db.db.prepare(
    "SELECT path FROM workspace_folders WHERE workspace_id = ? ORDER BY rowid",
  );
  const allFoldersStmt = db.db.prepare(
    "SELECT workspace_id, path FROM workspace_folders ORDER BY rowid",
  );
  const deleteFoldersStmt = db.db.prepare(
    "DELETE FROM workspace_folders WHERE workspace_id = ?",
  );
  const renameStmt = db.db.prepare(
    "UPDATE workspaces SET name = ? WHERE id = ?",
  );
  const deleteStmt = db.db.prepare("DELETE FROM workspaces WHERE id = ?");

  return {
    create(name, folders, options = {}): Workspace {
      const chat = options.chat ?? false;
      const createdAt = options.createdAt ?? Date.now();
      const id = crypto.randomUUID();
      insertStmt.run(id, name, chat ? 1 : 0, createdAt);
      for (const folder of folders) {
        insertFolderStmt.run(id, folder);
      }
      return toWorkspace(
        { id, name, created_at: createdAt, chat: chat ? 1 : 0 },
        folders,
      );
    },

    get(id: string): Workspace | undefined {
      const row = getStmt.get(id) as
        | { id: string; name: string; created_at: number; chat: number }
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
        chat: number;
      }>;
      // Load folders for every workspace in a single query (no N+1).
      const foldersByWorkspace = new Map<string, string[]>();
      for (
        const folder of allFoldersStmt.all() as Array<{
          workspace_id: string;
          path: string;
        }>
      ) {
        const list = foldersByWorkspace.get(folder.workspace_id);
        if (list) list.push(folder.path);
        else foldersByWorkspace.set(folder.workspace_id, [folder.path]);
      }
      return rows.map((row) =>
        toWorkspace(row, foldersByWorkspace.get(row.id) ?? [])
      );
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
