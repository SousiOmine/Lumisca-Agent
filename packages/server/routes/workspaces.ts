import type { Workspace, WorkspaceFileEntry } from "@lumisca/core";
import { listWorkspaceFiles, suggestWorkspaceFiles } from "@lumisca/core";
import { Hono } from "hono";
import { ttlCache } from "../cache.ts";
import {
  AppError,
  notFound,
  parseBody,
  requireNonEmptyString,
  requireStringArray,
} from "./util.ts";

interface WorkspaceBody {
  name?: unknown;
  folders?: unknown;
}

/** The slice of the core these routes need (interface segregation). */
export interface WorkspaceApi {
  list(): Workspace[];
  get(id: string): Workspace | undefined;
  create(name: string, folders: string[]): Promise<Workspace>;
  update(
    id: string,
    input: { name?: string; folders?: string[] },
  ): Promise<Workspace>;
  delete(id: string): Promise<void>;
}

/** File listings are cached per workspace for a short TTL: the walk is the
 * expensive part, and typing an @-mention queries repeatedly. The cache is
 * scoped to the app instance (not module-global) so instances and tests
 * never share state. */
const FILE_CACHE_TTL_MS = 10_000;
const FILE_CACHE_MAX = 64;

export function workspaceRoutes(core: WorkspaceApi): Hono {
  const app = new Hono();
  const fileCache = ttlCache<string, WorkspaceFileEntry[]>(
    FILE_CACHE_TTL_MS,
    FILE_CACHE_MAX,
  );

  app.get("/workspaces", (c) => c.json(core.list()));

  app.post("/workspaces", async (c) => {
    const body = await parseBody<WorkspaceBody>(c);
    if (!body) {
      throw new AppError("name (non-empty string) is required", 400);
    }
    const ws = await core.create(
      requireNonEmptyString(body.name, "name (non-empty string)"),
      requireStringArray(body.folders, "folders (non-empty string[])"),
    );
    return c.json(ws, 201);
  });

  app.get("/workspaces/:id", (c) => {
    const ws = core.get(c.req.param("id"));
    if (!ws) {
      throw notFound("Workspace", c.req.param("id"));
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
    const ws = await core.update(c.req.param("id"), {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.folders !== undefined
        ? {
            folders: requireStringArray(
              body.folders,
              "folders (non-empty string[])",
            ),
          }
        : {}),
    });
    return c.json(ws);
  });

  app.delete("/workspaces/:id", async (c) => {
    await core.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** @-mention file suggestions: the workspace tree (folder-relative
   * paths, e.g. `Aaa/README.md`) filtered by `query`, cached briefly. */
  app.get("/workspaces/:id/files", async (c) => {
    const id = c.req.param("id");
    const ws = core.get(id);
    if (!ws) {
      throw notFound("Workspace", id);
    }
    const query = c.req.query("query") ?? "";
    let entries = fileCache.get(id);
    if (entries === undefined) {
      entries = await listWorkspaceFiles(ws);
      fileCache.set(id, entries);
    }
    return c.json({ entries: suggestWorkspaceFiles(entries, query) });
  });

  return app;
}
