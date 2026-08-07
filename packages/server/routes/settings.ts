import { Hono } from "hono";
import { AppError, parseBody } from "./util.ts";

/** The slice of the core these routes need (interface segregation).
 * Credential filtering/guarding lives in the core, not here. */
export interface SettingsApi {
  listSettings(): Map<string, string>;
  setSetting(key: string, value: string): void;
}

export function settingRoutes(core: SettingsApi): Hono {
  const app = new Hono();

  app.get("/settings", (c) => {
    return c.json(Object.fromEntries(core.listSettings()));
  });

  app.put("/settings/:key", async (c) => {
    // Core refuses credential keys (throws CoreError → 403); credentials
    // have their own endpoint (/providers/:id/api-key).
    const body = await parseBody<{ value?: unknown }>(c);
    if (!body || typeof body.value !== "string") {
      throw new AppError("value (string) is required", 400);
    }
    core.setSetting(c.req.param("key"), body.value);
    return c.json({ ok: true });
  });

  return app;
}
