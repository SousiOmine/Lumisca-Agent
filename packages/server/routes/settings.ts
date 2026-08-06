import { Hono } from "hono";
import type { LumiscaCore } from "@lumisca/core";
import { jsonError } from "./util.ts";

export function settingRoutes(core: LumiscaCore): Hono {
  const app = new Hono();

  app.get("/settings", (c) => {
    const entries = core.settings.list();
    return c.json(Object.fromEntries(entries));
  });

  app.put("/settings/:key", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.value !== "string") {
      return c.json({ error: "value (string) is required" }, 400);
    }
    try {
      core.setSetting(c.req.param("key"), body.value);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  return app;
}
