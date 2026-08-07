import { Hono } from "hono";
import type { Workspace } from "@lumisca/core";
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

export function workspaceRoutes(core: WorkspaceApi): Hono {
  const app = new Hono();

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

  app.patch("/workspaces/:id/folders", async (c) => {
    const body = await parseBody<WorkspaceBody>(c);
    if (!body || !Array.isArray(body.folders)) {
      throw new AppError("folders (string[]) is required", 400);
    }
    await core.updateWorkspace(
      c.req.param("id"),
      { folders: folderList(body.folders) },
    );
    return c.json({ ok: true });
  });

  app.delete("/workspaces/:id", (c) => {
    core.deleteWorkspace(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
