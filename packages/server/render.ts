/**
 * The HTML document served by the app: a static shell. The React app is
 * rendered entirely client-side, so the shell only carries the theme (the
 * first paint is already themed — no flash), the inlined styles, and two
 * scripts: the externalized initial data + auth token (inline scripts are
 * banned by the page CSP), and the bundled client app.
 */

/**
 * Content-Security-Policy for the page. Inline scripts are banned, so
 * the initial data and auth token are served from /assets/initial-data.js
 * instead of an inline <script>. Inline style attributes (React style
 * props) need 'unsafe-inline' for styles. connect-src names the page's own
 * host for the WebSocket event stream — CSP3 would match 'self' for a
 * same-host ws: upgrade, but naming it explicitly is portable — and the
 * shell bridge host used by the desktop app (settings → 接続先サーバー;
 * the custom protocol is re-homed to http://lumisca.localhost for WebView2).
 * In a plain browser that host does not resolve and the bridge is unused.
 */
export function pageCsp(pageHost: string | undefined): string {
  const wsSrc = pageHost
    ? `connect-src 'self' ws://${pageHost} http://lumisca.localhost`
    : "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://lumisca.localhost";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: http:",
    wsSrc,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export interface HtmlDocumentOptions {
  /** Auth token for the UI. It is served via /assets/initial-data.js (CSP
   * bans inline scripts) — the script URL then carries `?token=` so the
   * guarded asset can be fetched. */
  token?: string;
  /** The page's own host (Host header), used by the CSP to name the
   * WebSocket endpoint when the page is served remotely. */
  pageHost?: string;
}

/** Assemble the full HTML document: the empty #root (client-rendered app),
 * themed first paint, and the two module scripts. */
export function renderHtmlDocument(
  css: string,
  theme: "light" | "dark",
  options: HtmlDocumentOptions = {},
): string {
  return `<!doctype html>
<html lang="ja" data-theme="${theme}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${
    pageCsp(
      options.pageHost,
    )
  }" />
    <title>Lumisca Agent</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/initial-data.js${
    options.token === undefined
      ? ""
      : `?token=${encodeURIComponent(options.token)}`
  }"></script>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;
}
