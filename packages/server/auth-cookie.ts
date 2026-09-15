/**
 * Browser-side memory of the auth token (`LUMISCA_TOKEN`).
 *
 * The token is a capability: every guarded request must carry it. Without a
 * cookie that means pasting it into the address bar of every visit
 * (`http://host:8000/?token=…`), which is what this module removes — the
 * URL is the credential once, the browser remembers it afterwards.
 *
 * The cookie is one accepted form among three, never a replacement: the
 * header stays authoritative for API clients (curl, the desktop shell's
 * health probe, federated peers) and the query parameter for clients
 * without a cookie jar (WebSocket handshakes, first-time page visits). See
 * `installSecurityMiddleware` in app.ts for the acceptance order.
 */

/** Cookie name. A `_<port>` suffix is added when the request's Host carries
 * a port — see {@link tokenCookieName}. */
const TOKEN_COOKIE_NAME = "lumisca_token";

/** How long a browser keeps the token. The token itself is a long-lived
 * static secret (service.env holds it until the operator rotates it), so
 * the cookie is the browser's copy of it rather than a session: expiring
 * it early would only ask the operator to paste the URL again. */
export const TOKEN_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Attributes of the token cookie. `HttpOnly` (page scripts never need to
 * read it: they either use the token the server embedded for them, or the
 * cookie travels by itself) and `SameSite=Lax` (sent on top-level
 * navigations plus same-site API/WebSocket requests, so cross-site POSTs
 * cannot ride on it) are the guards; `Secure` is deliberately absent
 * because remote hosting here is plain HTTP over a LAN or a Tailscale
 * address — a `Secure` cookie would simply never be sent. */
export const TOKEN_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
  maxAge: TOKEN_COOKIE_MAX_AGE_SECONDS,
} as const;

/** Port of a Host header, or "" when it has none (or cannot be parsed —
 * app.ts's Host guard rejects those before the token check, so the
 * fallback only keeps this function total). */
function hostPort(host: string | undefined): string {
  if (!host) return "";
  try {
    return new URL(`http://${host}`).port;
  } catch {
    return "";
  }
}

/**
 * Name of the token cookie for a request's Host, e.g. `lumisca_token_8000`.
 *
 * The port is part of the name because cookies ignore it: two servers on
 * one host (`deno task dev:server` on 8000 next to a packaged server on
 * 8100, say) would otherwise overwrite each other's cookie, leaving one of
 * them answering 401 until the operator pastes its token URL again. A Host
 * without a port (the default 80/443, typical behind a reverse proxy) has
 * nothing to tell instances apart, so it gets the bare name.
 */
export function tokenCookieName(host: string | undefined): string {
  const port = hostPort(host);
  return port === "" ? TOKEN_COOKIE_NAME : `${TOKEN_COOKIE_NAME}_${port}`;
}
