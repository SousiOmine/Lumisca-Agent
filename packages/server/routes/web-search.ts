import { Hono } from "hono";
import type {
  WebSearchSettingsView,
  WebSearchTestView,
} from "@lumisca/core/shared";
import {
  AppError,
  parseBody,
  requireBody,
  requireNonEmptyString,
} from "./util.ts";

/**
 * The web-search setting: which search provider the agent uses, and its key.
 *
 * A dedicated surface rather than the generic settings one, because the
 * stored value holds API keys: `/settings` filters it out (settings/guard.ts)
 * and the read here never includes them either — the view says whether a key
 * is stored, not what it is.
 *
 * Every mutation answers with the whole setting, so the screen replaces its
 * state instead of merging a delta it would have to trust.
 */

/** The slice of the core these routes need. */
export interface WebSearchApi {
  getWebSearchSettings(): WebSearchSettingsView;
  addWebSearchProvider(
    input: { id: string; apiKey: string },
  ): WebSearchSettingsView;
  updateWebSearchProvider(
    id: string,
    input: { apiKey: string },
  ): WebSearchSettingsView;
  removeWebSearchProvider(id: string): WebSearchSettingsView;
  setDefaultWebSearchProvider(id: string | null): WebSearchSettingsView;
  /** Search once with a key that is not saved yet. A failure to search is
   * the answer (`ok: false`), not an HTTP error: a wrong key is a result the
   * user acts on, not a broken request. */
  testWebSearchProvider(input: {
    id: string;
    apiKey: string | null;
  }): Promise<WebSearchTestView>;
}

export function webSearchRoutes(core: WebSearchApi): Hono {
  const app = new Hono();

  app.get("/web-search", (c) => {
    return c.json(core.getWebSearchSettings());
  });

  app.post("/web-search/providers", async (c) => {
    const body = requireBody(
      await parseBody<{ id?: unknown; apiKey?: unknown }>(c),
    );
    return c.json(
      core.addWebSearchProvider({
        id: requireNonEmptyString(body.id, "id (string)"),
        apiKey: requireNonEmptyString(body.apiKey, "apiKey (string)"),
      }),
      201,
    );
  });

  app.put("/web-search/providers/:id", async (c) => {
    const body = requireBody(await parseBody<{ apiKey?: unknown }>(c));
    const apiKey = body.apiKey;
    if (apiKey !== undefined && typeof apiKey !== "string") {
      throw new AppError("apiKey must be a string", 400);
    }
    // An omitted (or empty) key keeps the stored one: the screen edits a
    // provider without ever holding the secret.
    return c.json(
      core.updateWebSearchProvider(c.req.param("id"), {
        apiKey: apiKey ?? "",
      }),
    );
  });

  app.delete("/web-search/providers/:id", (c) => {
    return c.json(core.removeWebSearchProvider(c.req.param("id")));
  });

  app.put("/web-search/default", async (c) => {
    const body = requireBody(await parseBody<{ id?: unknown }>(c));
    const id = body.id;
    if (id !== null && id !== undefined && typeof id !== "string") {
      throw new AppError("id must be a string or null", 400);
    }
    // null turns search off. An absent field is treated as null as well: the
    // request says which provider to use, and saying none is how it does it.
    return c.json(
      core.setDefaultWebSearchProvider(
        typeof id === "string" ? id : null,
      ),
    );
  });

  app.post("/web-search/test", async (c) => {
    const body = requireBody(
      await parseBody<{ id?: unknown; apiKey?: unknown }>(c),
    );
    const apiKey = body.apiKey;
    if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") {
      throw new AppError("apiKey must be a string or null", 400);
    }
    return c.json(
      await core.testWebSearchProvider({
        id: requireNonEmptyString(body.id, "id (string)"),
        apiKey: typeof apiKey === "string" ? apiKey : null,
      }),
    );
  });

  return app;
}
