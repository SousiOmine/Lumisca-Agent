import { Hono } from "hono";
import type { Context } from "hono";
import {
  type Locale,
  MCP_OAUTH_CALLBACK_PATH,
  type McpAuthSnapshot,
  type McpInfo,
  type McpTestResult,
} from "@lumisca/core";
import { AppError, requireNonEmptyString } from "./util.ts";
import { renderMcpAuthPage } from "../render.ts";

/** The slice of the core these routes need (interface segregation). */
export interface McpApi {
  /** App-level (global) MCP config; applies to every workspace. */
  getAppMcpInfo(): McpInfo;
  setAppMcpConfig(text: string): McpInfo;
  /** A workspace's own `.mcp.json` (merged into sessions alongside the
   * app-level config). */
  getMcpInfo(workspaceId: string): McpInfo;
  setMcpConfig(workspaceId: string, text: string): McpInfo;
  /** One-shot connection test of a single server config: connect, list the
   * tools, disconnect. Runs here because the server owns the child
   * processes a stdio server needs. Reaching the server is reported as a
   * result (`ok:false`), an invalid body still throws. */
  testMcpServer(text: string): Promise<McpTestResult>;
  /** Start an interactive OAuth sign-in for one HTTP server. Resolves once
   * the flow waits for the browser (the snapshot carries the authorization
   * URL) or has failed to start. */
  startMcpAuth(text: string, redirectUri: string): Promise<McpAuthSnapshot>;
  getMcpAuth(sessionId: string): McpAuthSnapshot | undefined;
  cancelMcpAuth(sessionId: string): boolean;
  /** Finish the sign-in the browser came back to. */
  completeMcpAuth(
    input: { state: string; code?: string; error?: string },
  ): Promise<McpAuthSnapshot | undefined>;
}

async function putConfig(
  c: Context,
  apply: (text: string) => McpInfo | Promise<McpInfo>,
) {
  const text = await c.req.text();
  // Blank (or whitespace-only) bodies are rejected like an absent body:
  // there is no config to validate or store.
  requireNonEmptyString(text.trim(), "JSON body");
  return c.json(await apply(text));
}

/**
 * The redirect URI to register for the browser that asked: this app's own
 * origin plus the callback path.
 *
 * The `Origin` header is preferred because its scheme tells plain HTTP apart
 * from a TLS-terminating front end (a `tailscale serve` in front of the
 * server); it is trusted only for the host this request was addressed to,
 * which the security middleware validated. A client that sends no Origin
 * (curl, an older WebView) gets the request's own host over http.
 */
export function mcpRedirectUri(c: Context): string {
  // The Host header is what the security middleware validated; a served
  // request also carries the same value in its URL, which keeps callers
  // that build a request without the header (tests, embedded use) working.
  const host = c.req.header("host") ?? new URL(c.req.url).host;
  if (host === "") {
    throw new AppError("Cannot determine this server's host", 400);
  }
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    try {
      const url = new URL(origin);
      const httpish = url.protocol === "http:" || url.protocol === "https:";
      if (httpish && url.host === host) {
        return `${url.origin}${MCP_OAUTH_CALLBACK_PATH}`;
      }
    } catch {
      // Not a URL: fall through to the request's own host.
    }
  }
  return `http://${host}${MCP_OAUTH_CALLBACK_PATH}`;
}

/** The failure of an authorization response (RFC 6749 §4.1.2.1): the short
 * `error` code, with the readable `error_description` when one came too. */
function authorizationFailure(c: Context): string {
  const error = c.req.query("error") ?? "unknown_error";
  const description = c.req.query("error_description");
  return description === undefined ? error : `${error}: ${description}`;
}

/** MCP server configuration. The settings UI manages the app-level config
 * (`/api/mcp`, stored in the DB); each workspace's `.mcp.json` is merged in
 * automatically and can also be edited directly on disk.
 *
 * The `/api/mcp/auth*` routes drive an interactive OAuth sign-in (see
 * core/mcp/oauth-session.ts), and `/api/mcp/oauth/callback` is where the
 * authorization server returns the browser — reached without the app's
 * token (see app.ts) and answering HTML, since a person is looking at it. */
export function mcpRoutes(
  core: McpApi,
  /** The app language of a request: the callback page renders in it (it is
   * served before the client bundle loads, like the token page). */
  language: (c: Context) => Locale,
): Hono {
  const app = new Hono();

  app.get("/mcp", (c) => {
    return c.json(core.getAppMcpInfo());
  });

  app.put("/mcp", async (c) => {
    return await putConfig(c, (text) => core.setAppMcpConfig(text));
  });

  // The settings UI's "test" button: the body is the same single-server
  // JSON a PUT would store, so the probe sees exactly what would be saved.
  app.post("/mcp/test", async (c) => {
    const text = await c.req.text();
    requireNonEmptyString(text.trim(), "JSON body");
    return c.json(await core.testMcpServer(text));
  });

  // OAuth sign-in of one HTTP server: same single-server JSON body. The
  // flow runs in this process, so it must know where the browser will be
  // sent back to — see mcpRedirectUri.
  app.post("/mcp/auth", async (c) => {
    const text = await c.req.text();
    requireNonEmptyString(text.trim(), "JSON body");
    return c.json(await core.startMcpAuth(text, mcpRedirectUri(c)));
  });

  app.get("/mcp/auth/:id", (c) => {
    const snapshot = core.getMcpAuth(c.req.param("id"));
    if (snapshot === undefined) {
      throw new AppError("MCP sign-in session not found", 404);
    }
    return c.json(snapshot);
  });

  app.post("/mcp/auth/:id/cancel", (c) => {
    if (!core.cancelMcpAuth(c.req.param("id"))) {
      throw new AppError("MCP sign-in session not found", 404);
    }
    return c.json({ ok: true });
  });

  // Where the authorization server sends the browser back. It is a
  // navigation, not an API call: the answer is a page for whoever is
  // looking at it. The request carries no credential by design (app.ts
  // exempts this path from the token guard — the browser tab that comes
  // back may not be the one the app is open in); its `state` is what
  // identifies the sign-in, and the only thing it can finish is that one.
  app.get("/mcp/oauth/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const hasError = c.req.query("error") !== undefined;
    const snapshot = state === undefined ? undefined : await core
      .completeMcpAuth({
        state,
        ...(code !== undefined ? { code } : {}),
        ...(hasError ? { error: authorizationFailure(c) } : {}),
      });
    if (snapshot === undefined) {
      return c.html(renderMcpAuthPage(language(c), "missing"), 404);
    }
    if (snapshot.status === "done") {
      return c.html(renderMcpAuthPage(language(c), "done"));
    }
    return c.html(
      renderMcpAuthPage(language(c), "failed", snapshot.error ?? ""),
      400,
    );
  });

  app.get("/workspaces/:id/mcp", (c) => {
    return c.json(core.getMcpInfo(c.req.param("id")));
  });

  app.put("/workspaces/:id/mcp", async (c) => {
    return await putConfig(
      c,
      (text) => core.setMcpConfig(c.req.param("id"), text),
    );
  });

  return app;
}
