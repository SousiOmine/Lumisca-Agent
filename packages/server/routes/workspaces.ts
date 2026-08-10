import { Hono } from "hono";
import type { Workspace, WorkspaceFileEntry } from "@lumisca/core";
import { listWorkspaceFiles, suggestWorkspaceFiles } from "@lumisca/core";
import { AppError, parseBody } from "./util.ts";

interface WorkspaceBody {
  name?: unknown;
  folders?: unknown;
}

/** Coerce a parsed body into a string array; throws 400 on wrong types
 * instead of silently stringifying numbers/null into `"null"`. */
function folderList(folders: unknown): string[] {
  if (
    !Array.isArray(folders) ||
    folders.some((f) => typeof f !== "string" || f.length === 0)
  ) {
    throw new AppError("folders (non-empty string[]) is required", 400);
  }
  return folders as string[];
}

/** The slice of the core these routes need (interface segregation). */
export interface WorkspaceApi {
  listWorkspaces(): Workspace[];
  getWorkspace(id: string): Workspace | undefined;
  createWorkspace(name: string, folders: string[]): Promise<Workspace>;
  updateWorkspace(
    id: string,
    input: { name?: string; folders?: string[] },
  ): Promise<Workspace>;
  deleteWorkspace(id: string): void;
}

/** File listings are cached per workspace for a short TTL: the walk is the
 * expensive part, and typing an @-mention queries repeatedly. The cache is
 * scoped to the app instance (not module-global) so instances and tests
 * never share state. */
const FILE_CACHE_TTL_MS = 10_000;
const FILE_CACHE_MAX = 64;

export function workspaceRoutes(core: WorkspaceApi): Hono {
  const app = new Hono();
  const fileCache = new Map<
    string,
    { at: number; entries: WorkspaceFileEntry[] }
  >();

  app.get("/workspaces", (c) => c.json(core.listWorkspaces()));

  app.post("/workspaces", async (c) => {
    const body = await parseBody<WorkspaceBody>(c);
    if (!body || typeof body.name !== "string" || body.name.length === 0) {
      throw new AppError("name (non-empty string) is required", 400);
    }
    const ws = await core.createWorkspace(body.name, folderList(body.folders));
    return c.json(ws, 201);
  });

  app.get("/workspaces/:id", (c) => {
    const ws = core.getWorkspace(c.req.param("id"));
    if (!ws) {
      throw new AppError(`Workspace not found: ${c.req.param("id")}`, 404);
    }
    return c.json(ws);
  });

  app.patch("/workspaces/:id", async (c) => {
    const body = await parseBody<WorkspaceBody>(c);
    if (
      !body ||
      (typeof body.name !== "undefined" && typeof body.name !== "string") ||
      (typeof body.folders !== "undefined" && !Array.isArray(body.folders))
    ) {
      throw new AppError(
        "name (string) and/or folders (string[]) expected",
        400,
      );
    }
    const ws = await core.updateWorkspace(c.req.param("id"), {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.folders !== undefined
        ? { folders: folderList(body.folders) }
        : {}),
    });
    return c.json(ws);
  });

  app.delete("/workspaces/:id", (c) => {
    core.deleteWorkspace(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** @-mention file suggestions: the workspace tree (folder-relative
   * paths, e.g. `Aaa/README.md`) filtered by `query`, cached briefly. */
  app.get("/workspaces/:id/files", async (c) => {
    const id = c.req.param("id");
    const ws = core.getWorkspace(id);
    if (!ws) {
      throw new AppError(`Workspace not found: ${id}`, 404);
    }
    const query = c.req.query("query") ?? "";
    const cached = fileCache.get(id);
    let entries: WorkspaceFileEntry[];
    if (cached && Date.now() - cached.at < FILE_CACHE_TTL_MS) {
      entries = cached.entries;
    } else {
      entries = await listWorkspaceFiles(ws);
      fileCache.set(id, { at: Date.now(), entries });
      if (fileCache.size > FILE_CACHE_MAX) {
        let oldest: string | undefined;
        for (const [key, value] of fileCache) {
          if (oldest === undefined || value.at < fileCache.get(oldest)!.at) {
            oldest = key;
          }
        }
        if (oldest !== undefined) fileCache.delete(oldest);
      }
    }
    return c.json({ entries: suggestWorkspaceFiles(entries, query) });
  });

  return app;
}
