import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { MCP_OAUTH_CALLBACK_PATH } from "@lumisca/core";
import { isLoopbackHost, type Locale } from "@lumisca/core/shared";
import { TOKEN_COOKIE_OPTIONS, tokenCookieName } from "./auth-cookie.ts";
import { renderTokenRequiredPage } from "./render.ts";

/** What the guards need from the launcher. */
export interface SecurityOptions {
  /** Bearer token every request must present (header, query or cookie). */
  token?: string;
  /** Extra hostnames the Host guard accepts (no port). */
  allowedHosts?: readonly string[];
}

/** Startup validation: a non-loopback bind without a token would expose the
 * agent (bash tool included) to anyone who can reach the address. Returns an
 * error message, or null when the configuration is safe. */
export function validateHostConfig(
  host: string,
  token: string | undefined,
): string | null {
  if (isLoopbackHost(host) || token) return null;
  return `binding to "${host}" without LUMISCA_TOKEN would expose the agent ` +
    "to the network; set LUMISCA_TOKEN or bind a loopback address";
}

/** Validate the Host header for embedding into the page (the CSP names
 * the WebSocket endpoint). The host guard already rejected non-loopback /
 * disallowed hostnames; this re-parses so only a clean hostname:port is
 * ever embedded — a raw header containing userinfo or quotes could
 * otherwise inject into the CSP meta tag. Returns "" when unparseable. */
export function safePageHost(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  try {
    return new URL(`http://${hostHeader}`).host;
  } catch {
    return "";
  }
}

function hostnameOf(host: string | undefined): string {
  if (!host) return "";
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

/** Paths the token guard lets through: the app's bundle and icon (no
 * secret in them) and the MCP OAuth callback. `/assets/initial-data.js`
 * carries the token itself and is deliberately absent. */
function unguardedPath(path: string): boolean {
  return path === "/assets/app.js" || path === "/styles.css" ||
    path === "/favicon.png" || path === MCP_OAUTH_CALLBACK_PATH;
}

/** Origins allowed to read cross-origin responses (the Tauri WebView). */
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
]);

/** Whether `origin` (a browser's Origin header) names the server this
 * request was addressed to, whose Host header is `host`.
 *
 * The scheme is deliberately not compared. A TLS-terminating front end
 * (`tailscale serve`, a reverse proxy) accepts https from the browser and
 * forwards plain http here, so a request's Host is the page's host while the
 * page's Origin says `https:`. Comparing full origins made every such page
 * cross-origin against its own server: the WebSocket handshake was answered
 * 403 (`Forbidden: cross-origin WebSocket`), the page therefore received no
 * event, and the UI fell back to its 10-second snapshot poll — remote
 * sessions arrived up to ten seconds late and streaming text never flowed.
 * Host and port are what identify the server; the scheme describes only the
 * hop the browser took to reach it.
 *
 * `localhost` / `127.0.0.1` / `::1` are the same server under different
 * names; those spellings are interchangeable here, and only for loopback
 * (a remote name is not an alias of anything).
 *
 * The MCP sign-in uses this too: the redirect URI it registers must be the
 * page's own origin, and the question "is that origin this server?" has one
 * answer (see routes/mcp.ts).
 */
export function sameServerAuthority(
  origin: string,
  host: string | undefined,
): boolean {
  try {
    const actual = new URL(origin);
    // A browser's Origin is an http(s) origin. Anything else (an opaque
    // scheme, a `file:` page) names no server this API could be served by;
    // the Tauri WebView's own schemes are in ALLOWED_ORIGINS below.
    if (actual.protocol !== "http:" && actual.protocol !== "https:") {
      return false;
    }
    // The Host header under the ORIGIN's scheme: that is what normalizes an
    // explicit default port away (`Host: host:443` and `Origin:
    // https://host` are the same authority), while a port that is really
    // different stays different.
    const expected = new URL(`${actual.protocol}//${host}`);
    // Host and port together: a different port must never pass (any other
    // local dev server would otherwise read the API cross-origin).
    if (actual.host === expected.host) return true;
    return actual.port === expected.port &&
      isLoopbackHost(actual.hostname) &&
      isLoopbackHost(hostnameOf(host));
  } catch {
    return false;
  }
}

/** Whether `origin` may read this server's responses. */
function isAllowedOrigin(origin: string, host: string | undefined): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return sameServerAuthority(origin, host);
}

/** The security middleware chain: Host guard (DNS-rebinding protection),
 * optional bearer token, CORS (same-origin + Tauri WebView), and the
 * WebSocket Origin check (CORS does not apply to WS handshakes). Extracted
 * so createApp stays a composition root over routes. `language` resolves
 * the app language of one request: the token-required page is the one
 * response rendered before the client bundle loads, so its text comes from
 * the catalogue (see createApp's languageFor). */
export function installSecurityMiddleware(
  app: Hono,
  options: SecurityOptions,
  language: (c: Context) => Locale,
): void {
  // The server is local-only by default: refuse requests that do not target
  // a loopback host (blocks DNS rebinding and cross-origin browser access).
  // Remote hosting opens additional hostnames via allowedHosts; the Host
  // check still applies to them, so DNS rebinding stays blocked.
  const allowedHosts = new Set(
    (options.allowedHosts ?? []).map((h) => h.toLowerCase()),
  );
  app.use("*", async (c, next) => {
    const host = hostnameOf(c.req.header("host"));
    if (!isLoopbackHost(host) && !allowedHosts.has(host)) {
      return c.text(
        "Forbidden: host is not allowed (loopback or LUMISCA_ALLOWED_HOSTS)",
        403,
      );
    }
    await next();
  });

  // Optional bearer token: blocks arbitrary local processes (curl, other
  // apps) from driving the agent, and — for remote hosting — anyone without
  // the token from reaching the page itself. The token is accepted as the
  // X-Lumisca-Token header, the `token` query parameter (WebSocket
  // handshakes; also `?token=` on the page URL, which is how the desktop
  // shell and a first-time browser open the UI), or the cookie the browser
  // keeps after such a visit (auth-cookie.ts).
  //
  // Two kinds of path skip the guard: the app's own bundle and icon (which
  // carry no secret, so the page can load them without a token query), and
  // the MCP OAuth callback (the browser coming back from the authorization
  // server may not be the one the app is open in, and it carries only the
  // `state` of a sign-in this server started). `/assets/initial-data.js` is
  // NOT public: it carries the token itself.
  if (options.token) {
    const token = options.token;
    app.use("*", async (c, next) => {
      if (!unguardedPath(c.req.path)) {
        const cookieName = tokenCookieName(c.req.header("host"));
        const remembered = getCookie(c, cookieName);
        const presented = c.req.header("x-lumisca-token") ??
          c.req.query("token");
        if (presented !== token && remembered !== token) {
          // A browser (Accept: text/html) is told what to do; every other
          // client keeps the JSON error it can parse. The page renders in
          // the language of this request (it is served before the app
          // loads, so the catalogue is the only source of its text).
          return c.req.header("accept")?.includes("text/html")
            ? c.html(renderTokenRequiredPage(language(c)), 401)
            : c.json(
              { error: "Unauthorized: missing or invalid token" },
              401,
            );
        }
        // The client presented the token itself, so let the browser
        // remember it: the next visit — an address without any credential —
        // then passes this guard.
        if (remembered !== token) {
          setCookie(c, cookieName, token, TOKEN_COOKIE_OPTIONS);
        }
      }
      await next();
    });
  }

  // The desktop shell (Tauri WebView) calls the API from another origin,
  // and a page behind a TLS-terminating front end is addressed over https
  // while this server sees plain http. Only the same host (under either
  // scheme) and the Tauri WebView origins may read responses.
  const corsHandler = cors({
    origin: (origin, c) =>
      isAllowedOrigin(origin, c.req.header("host")) ? origin : undefined,
    allowHeaders: ["content-type", "x-lumisca-token"],
  });
  app.use("/api/*", corsHandler);
  app.use("/ws", corsHandler);

  // Browsers send an Origin on WebSocket handshakes; CORS does not apply to
  // WS, so without this check any website could open ws://127.0.0.1:<port>/ws
  // and read every agent event. Non-browser clients (no Origin) are allowed —
  // they are already gated by the loopback-only Host check above. What the
  // origin has to match is the host (see isAllowedOrigin): a page behind a
  // TLS front end is same-host over https, not a foreign origin.
  app.use("/ws", async (c, next) => {
    const origin = c.req.header("origin");
    if (
      origin !== undefined && !isAllowedOrigin(origin, c.req.header("host"))
    ) {
      return c.text("Forbidden: cross-origin WebSocket", 403);
    }
    await next();
  });
}
