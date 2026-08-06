import { Hono } from "hono";
import type { LumiscaCore } from "@lumisca/core";
import { jsonError } from "./util.ts";

export function sessionRoutes(core: LumiscaCore): Hono {
  const app = new Hono();

  app.get("/sessions", (c) => {
    const workspaceId = c.req.query("workspaceId");
    return c.json(core.listSessions(workspaceId));
  });

  app.get("/sessions/default-model", (c) => {
    return c.json(core.getDefaultModel());
  });

  app.get("/sessions/:id", (c) => {
    const session = core.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json(session);
  });

  app.get("/sessions/:id/messages", async (c) => {
    await core.openSession(c.req.param("id"));
    const agent = core.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "not found" }, 404);
    return c.json(agent.messages);
  });

  app.post("/sessions", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.workspaceId !== "string") {
      return c.json({ error: "workspaceId (string) is required" }, 400);
    }
    try {
      const session = core.createSession({
        workspaceId: body.workspaceId,
        name: typeof body.name === "string" ? body.name : undefined,
        modelProvider: typeof body.modelProvider === "string"
          ? body.modelProvider
          : undefined,
        modelId: typeof body.modelId === "string" ? body.modelId : undefined,
        systemPrompt: typeof body.systemPrompt === "string"
          ? body.systemPrompt
          : undefined,
      });
      return c.json(session, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/sessions/:id/open", async (c) => {
    try {
      const session = await core.openSession(c.req.param("id"));
      return c.json(session);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/sessions/:id/close", (c) => {
    core.closeSession(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.delete("/sessions/:id", (c) => {
    core.deleteSession(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/prompt", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || body.text.length === 0) {
      return c.json({ error: "text (string) is required" }, 400);
    }
    try {
      await core.prompt(c.req.param("id"), body.text);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/sessions/:id/steer", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string") {
      return c.json({ error: "text (string) is required" }, 400);
    }
    try {
      await core.steer(c.req.param("id"), body.text);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/sessions/:id/follow-up", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string") {
      return c.json({ error: "text (string) is required" }, 400);
    }
    try {
      await core.followUp(c.req.param("id"), body.text);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/sessions/:id/abort", (c) => {
    try {
      core.abort(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/sessions/:id/model", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body || typeof body.provider !== "string" ||
      typeof body.modelId !== "string"
    ) {
      return c.json(
        { error: "provider and modelId (strings) are required" },
        400,
      );
    }
    try {
      core.setSessionModel(c.req.param("id"), body.provider, body.modelId);
      const session = core.getSession(c.req.param("id"));
      return c.json(session);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  return app;
}
