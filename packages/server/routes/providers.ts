import { Hono } from "hono";
import type { AuthCheck, ModelInfo, Provider } from "@lumisca/core";
import { AppError, parseBody } from "./util.ts";

/** Auth checks are cached briefly; invalidated when an API key changes. */
const AUTH_CACHE_TTL = 30_000;

/** The slice of the core these routes need (interface segregation). */
export interface ProviderApi {
  listProviders(): readonly Provider[];
  listModelsDetailed(providerId: string): ModelInfo[];
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void;
  checkAuth(providerId: string): Promise<AuthCheck | undefined>;
  setProviderApiKey(providerId: string, key: string): Promise<void>;
}

export function providerRoutes(core: ProviderApi): Hono {
  const app = new Hono();

  const authCache = new Map<string, {
    configured: boolean;
    source?: string;
    expires: number;
  }>();
  const cachedAuth = async (providerId: string) => {
    const cached = authCache.get(providerId);
    if (cached && cached.expires > Date.now()) return cached;
    let check: AuthCheck | undefined;
    try {
      check = await core.checkAuth(providerId);
    } catch {
      // A transient checkAuth failure (network) must not be cached as
      // "not configured" — that would lie to the settings UI.
      return { configured: false, expires: Date.now() + AUTH_CACHE_TTL };
    }
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
      core.listProviders().map(async (p) => {
        const check = await cachedAuth(p.id);
        return { id: p.id, name: p.name, ...check };
      }),
    );
    return c.json(providers);
  });

  app.get("/providers/:id/models", (c) => {
    const id = c.req.param("id");
    const provider = core.listProviders().find((p) => p.id === id);
    if (!provider) {
      throw new AppError(`Provider not found: ${id}`, 404);
    }
    return c.json(core.listModelsDetailed(id));
  });

  app.put("/providers/:id/models/:modelId", async (c) => {
    const body = await parseBody<{ enabled?: unknown }>(c);
    if (!body || typeof body.enabled !== "boolean") {
      throw new AppError("enabled (boolean) is required", 400);
    }
    // Hono already decodes path params once; the client percent-encodes
    // model ids, so decoding again here would corrupt ids containing `+`
    // (or throw on malformed escapes like %zz).
    core.setModelEnabled(
      c.req.param("id"),
      c.req.param("modelId"),
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
    const body = await parseBody<{ key?: unknown }>(c);
    if (!body || typeof body.key !== "string" || body.key.length === 0) {
      throw new AppError("key (string) is required", 400);
    }
    await core.setProviderApiKey(c.req.param("id"), body.key);
    invalidateAuth(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
