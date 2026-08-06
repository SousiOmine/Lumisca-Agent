import { Hono } from "npm:hono@4";
import type { LumiscaCore } from "@lumisca/core";
import { jsonError } from "./util.ts";

/** Auth checks are cached briefly; invalidated when an API key changes. */
const AUTH_CACHE_TTL = 30_000;

export function providerRoutes(core: LumiscaCore): Hono {
  const app = new Hono();

  const authCache = new Map<string, {
    configured: boolean;
    source?: string;
    expires: number;
  }>();
  const cachedAuth = async (providerId: string) => {
    const cached = authCache.get(providerId);
    if (cached && cached.expires > Date.now()) return cached;
    const check = await core.models.checkAuth(providerId).catch(() => undefined);
    const entry = {
      configured: check !== undefined,
      source: check?.source,
      expires: Date.now() + AUTH_CACHE_TTL,
    };
    authCache.set(providerId, entry);
    return entry;
  };
  const invalidateAuth = (providerId: string) => authCache.delete(providerId);

  app.get("/providers", async (c) => {
    const providers = await Promise.all(
      core.models.getProviders().map(async (p) => {
        const check = await cachedAuth(p.id);
        return { id: p.id, name: p.name, ...check };
      }),
    );
    return c.json(providers);
  });

  app.get("/providers/:id/models", (c) => {
    const id = c.req.param("id");
    const provider = core.models.getProviders().find((p) => p.id === id);
    if (!provider) return c.json({ error: "provider not found" }, 404);
    return c.json(core.listModelsDetailed(id));
  });

  app.put("/providers/:id/models/:modelId", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) is required" }, 400);
    }
    core.setModelEnabled(
      c.req.param("id"),
      decodeURIComponent(c.req.param("modelId")),
      body.enabled,
    );
    return c.json({ ok: true });
  });

  app.get("/providers/:id/auth", async (c) => {
    const id = c.req.param("id");
    const check = await cachedAuth(id);
    return c.json({ providerId: id, ...check });
  });

  app.post("/providers/:id/api-key", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.key !== "string" || body.key.length === 0) {
      return c.json({ error: "key (string) is required" }, 400);
    }
    try {
      await core.setProviderApiKey(c.req.param("id"), body.key);
      invalidateAuth(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  return app;
}
