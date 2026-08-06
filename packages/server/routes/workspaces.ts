import { Hono } from "hono";
import type { LumiscaCore } from "@lumisca/core";
import { jsonError } from "./util.ts";

export function workspaceRoutes(core: LumiscaCore): Hono {
  const app = new Hono();

  app.get("/workspaces", (c) => c.json(core.listWorkspaces()));

  app.post("/workspaces", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body || typeof body.name !== "string" || !Array.isArray(body.folders)
    ) {
      return c.json({
        error: "name (string) and folders (string[]) are required",
      }, 400);
    }
    try {
      const ws = await core.createWorkspace(
        body.name,
        body.folders.map(String),
      );
      return c.json(ws, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/workspaces/:id", (c) => {
    const ws = core.getWorkspace(c.req.param("id"));
    if (!ws) return c.json({ error: "not found" }, 404);
    return c.json(ws);
  });

  app.patch("/workspaces/:id/folders", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.folders)) {
      return c.json({ error: "folders (string[]) is required" }, 400);
    }
    try {
      await core.updateWorkspaceFolders(
        c.req.param("id"),
        body.folders.map(String),
      );
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.delete("/workspaces/:id", (c) => {
    core.deleteWorkspace(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
