import { Hono } from "hono";
import type {
  AuthCheck,
  AuthInteraction,
  AuthType,
  ModelInfo,
  Provider,
  ProviderAuthType,
  UserProviderInput,
  UserProviderSummary,
} from "@lumisca/core";
import { AppError, parseBody, ttlCache } from "./util.ts";
import { LoginSessions } from "../login.ts";

/** Auth checks are cached briefly; invalidated when a key or credential
 * (login/logout) changes. */
const AUTH_CACHE_TTL = 30_000;

/** The slice of the core these routes need (interface segregation). */
export interface ProviderApi {
  listProviders(): readonly Provider[];
  listModelsDetailed(providerId: string): ModelInfo[];
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void;
  setModelThinkingLevel(
    providerId: string,
    modelId: string,
    level: string,
  ): string;
  /** Resolve a provider's effective auth (env var, stored key, OAuth
   * credential); may involve a network check. `source` distinguishes
   * "stored credential" / "OAuth" from ambient env vars. */
  checkAuth(providerId: string): Promise<AuthCheck | undefined>;
  /** Whether the provider is set up inside Lumisca (stored credential or
   * custom-provider config); ambient env auth of built-in providers does
   * not count. */
  hasConfiguredAuth(providerId: string): Promise<boolean>;
  setProviderApiKey(providerId: string, key: string): Promise<void>;
  getProviderAuthType(
    providerId: string,
  ): ProviderAuthType | undefined;
  /** Run a provider-owned login flow (OAuth) with the given interaction. */
  loginProvider(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<void>;
  logoutProvider(providerId: string): Promise<void>;
  /** Whether the provider was added by the user (OpenAI-compatible custom
   * provider) rather than built in or from env/models.json config. */
  isUserProvider(providerId: string): boolean;
  /** List user-defined OpenAI-compatible providers (no API key returned). */
  listUserProviders(): Promise<UserProviderSummary[]>;
  /** Create a user-defined OpenAI-compatible provider. */
  addUserProvider(input: UserProviderInput): Promise<UserProviderSummary>;
  /** Update a user-defined OpenAI-compatible provider (id from the path). */
  updateUserProvider(
    id: string,
    input: UserProviderInput,
  ): Promise<UserProviderSummary>;
  /** Remove a user-defined OpenAI-compatible provider and its API key. */
  removeUserProvider(id: string): Promise<void>;
}

export function providerRoutes(core: ProviderApi): Hono {
  const app = new Hono();

  const authCache = ttlCache<
    string,
    { configured: boolean; source?: string; authType?: ProviderAuthType }
  >(
    AUTH_CACHE_TTL,
  );
  const cachedAuth = async (providerId: string) => {
    const cached = authCache.get(providerId);
    if (cached) return cached;
    const authType = core.getProviderAuthType(providerId);
    // "Configured" means set up inside Lumisca (stored credential /
    // custom-provider config). Ambient env vars the SDK resolves (e.g.
    // ANTHROPIC_API_KEY set for other tools) must not surface as
    // configured — the settings list, badges and pickers all ride on this
    // flag. checkAuth below still resolves ambient auth, so `source`
    // stays informative for providers that resolve that way.
    const configured = await core.hasConfiguredAuth(providerId);
    let check: AuthCheck | undefined;
    try {
      check = await core.checkAuth(providerId);
    } catch {
      // A transient checkAuth failure (network) must not flip a
      // configured provider to "not configured" — the store verdict above
      // stands (and nothing is cached as resolved either).
      return { configured, authType };
    }
    const entry = {
      configured,
      source: check?.source,
      // check.type (e.g. a stored OAuth credential) wins over the static
      // capability so the settings UI picks the right control either way.
      authType: check?.type ?? authType,
    };
    authCache.set(providerId, entry);
    return entry;
  };
  const invalidateAuth = (providerId: string) => authCache.delete(providerId);

  app.get("/providers", async (c) => {
    const providers = await Promise.all(
      core.listProviders().map(async (p) => {
        const check = await cachedAuth(p.id);
        return {
          id: p.id,
          name: p.name,
          ...check,
          userDefined: core.isUserProvider(p.id),
        };
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

  app.put("/providers/:id/models/:modelId/thinking-level", async (c) => {
    const body = await parseBody<{ level?: unknown }>(c);
    if (!body || typeof body.level !== "string") {
      throw new AppError("level (string) is required", 400);
    }
    const thinkingLevel = core.setModelThinkingLevel(
      c.req.param("id"),
      c.req.param("modelId"),
      body.level,
    );
    return c.json({ ok: true, thinkingLevel });
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

  // OAuth login sessions (ChatGPT Plus/Pro and other subscription
  // providers). The flow runs server-side; the client polls the session
  // until it settles and answers any prompt the flow forwards. On Deno only
  // the device-code method works, which the bridge auto-selects.
  const loginSessions = new LoginSessions();

  app.post("/providers/:id/login", (c) => {
    const id = c.req.param("id");
    if (!core.listProviders().some((p) => p.id === id)) {
      throw new AppError(`Provider not found: ${id}`, 404);
    }
    if (core.getProviderAuthType(id) !== "oauth") {
      throw new AppError(`${id} does not support OAuth login`, 400);
    }
    // Reuse an already-running flow so repeated clicks cannot stack
    // concurrent polls (which OpenAI rate-limits with 429 errors).
    const active = loginSessions.getActive(id);
    if (active) return c.json({ sessionId: active.sessionId });
    const session = loginSessions.create(
      id,
      (interaction) => core.loginProvider(id, "oauth", interaction),
    );
    return c.json({ sessionId: session.sessionId });
  });

  app.get("/providers/:id/login/:sessionId", (c) => {
    const id = c.req.param("id");
    const session = loginSessions.get(c.req.param("sessionId"));
    if (!session || session.providerId !== id) {
      throw new AppError("Login session not found", 404);
    }
    // Once the flow has persisted a credential, drop the stale auth cache
    // so the model picker sees the provider as configured.
    if (session.consumeDone()) invalidateAuth(id);
    return c.json(session.snapshot());
  });

  app.post("/providers/:id/login/:sessionId/respond", async (c) => {
    const id = c.req.param("id");
    const session = loginSessions.get(c.req.param("sessionId"));
    if (!session || session.providerId !== id) {
      throw new AppError("Login session not found", 404);
    }
    const body = await parseBody<{ promptId?: unknown; value?: unknown }>(c);
    if (
      !body || typeof body.promptId !== "string" ||
      typeof body.value !== "string"
    ) {
      throw new AppError("promptId and value (strings) are required", 400);
    }
    if (!session.respond(body.promptId, body.value)) {
      throw new AppError("Prompt not found", 404);
    }
    return c.json({ ok: true });
  });

  app.post("/providers/:id/login/:sessionId/cancel", (c) => {
    const id = c.req.param("id");
    const session = loginSessions.get(c.req.param("sessionId"));
    if (!session || session.providerId !== id) {
      throw new AppError("Login session not found", 404);
    }
    session.cancel();
    return c.json({ ok: true });
  });

  app.post("/providers/:id/logout", async (c) => {
    const id = c.req.param("id");
    await core.logoutProvider(id);
    invalidateAuth(id);
    return c.json({ ok: true });
  });

  // --- user-defined OpenAI-compatible providers ----------------------------

  app.get("/providers/user", async (c) => {
    return c.json(await core.listUserProviders());
  });

  app.post("/providers/user", async (c) => {
    const body = await parseBody<UserProviderInput>(c);
    if (body === undefined) {
      throw new AppError("provider config (object) is required", 400);
    }
    // CoreError ("invalid") → 400, ("not_found") → 404 via the global
    // error handler; id uniqueness is enforced by upsert (the id is the
    // key), so no extra collision check is needed here.
    const created = await core.addUserProvider(body);
    return c.json(created, 201);
  });

  app.put("/providers/user/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody<UserProviderInput>(c);
    if (body === undefined) {
      throw new AppError("provider config (object) is required", 400);
    }
    const updated = await core.updateUserProvider(id, body);
    return c.json(updated);
  });

  app.delete("/providers/user/:id", async (c) => {
    const id = c.req.param("id");
    await core.removeUserProvider(id);
    return c.json({ ok: true });
  });

  return app;
}
