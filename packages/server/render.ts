/**
 * The HTML documents served by the app. `renderHtmlDocument` is the app
 * itself: a static shell. The Preact app is rendered entirely client-side,
 * so the shell only carries the theme (the first paint is already themed —
 * no flash), the inlined styles, and two scripts: the externalized initial
 * data + auth token (inline scripts are banned by the page CSP), and the
 * bundled client app. `renderTokenRequiredPage` is what an unauthenticated
 * browser lands on instead (the token guard's 401).
 */

/**
 * Content-Security-Policy for the page. Inline scripts are banned, so
 * the initial data and auth token are served from /assets/initial-data.js
 * instead of an inline <script>. Inline style attributes (style props)
 * need 'unsafe-inline' for styles. connect-src names the page's own
 * host for the WebSocket event stream — CSP3 would match 'self' for a
 * same-host ws: upgrade, but naming it explicitly is portable — and the
 * shell bridge used by the desktop app (settings → 接続先サーバー): the
 * `lumisca://` custom protocol, which WebView2 (Windows) re-homes to
 * http://lumisca.localhost while WKWebView (macOS) and WebKitGTK (Linux)
 * fetch the custom scheme directly, so both forms are allowed. In a plain
 * browser neither resolves and the bridge is unused.
 */
export function pageCsp(pageHost: string | undefined): string {
  const wsSrc = pageHost
    ? `connect-src 'self' ws://${pageHost} http://lumisca.localhost lumisca:`
    : "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://lumisca.localhost lumisca:";
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
   * guarded asset can be fetched. A browser that authenticates with its
   * cookie (see auth-cookie.ts) gets the token all the same: the desktop
   * shell's bridge key and the UI's request header are built from it, and
   * the page has to keep working when the address bar is reloaded without
   * `?token=` (the client strips it after the first load). */
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
    <link rel="icon" href="/favicon.png" />
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

/** The document an unauthenticated request gets instead of the app (401):
 * a browser landing here has no valid credential — no cookie yet, a cookie
 * from another server instance, or a mistyped token. It answers the two
 * questions that situation raises ("why can't I see the app?" and "what do
 * I do now?") and nothing else.
 *
 * Deliberately self-contained: every asset of the app is guarded too, so
 * the page carries its own minimal styling. It is the one response served
 * without any credential, so it names no host, port or token. */
export function renderTokenRequiredPage(): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lumisca Agent — トークンが必要です</title>
    <style>
      :root { color-scheme: dark light; }
      body {
        font-family: system-ui, sans-serif;
        margin: 0; padding: 48px 24px; line-height: 1.7;
      }
      main { max-width: 640px; margin: 0 auto; }
      h1 { font-size: 20px; }
      pre {
        background: rgba(127, 127, 127, 0.18);
        padding: 12px 16px; border-radius: 6px; overflow-x: auto;
      }
      code {
        background: rgba(127, 127, 127, 0.18);
        padding: 2px 6px; border-radius: 4px;
      }
      p.note { opacity: 0.75; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>トークンが必要です</h1>
      <p>
        このサーバーはトークン認証が有効です。ブラウザにトークンが保存されていない、または保存されたトークンが一致しないため、このページを表示できません。
      </p>
      <p>次の形式の URL を<strong>一度だけ</strong>開いてください。2 回目以降はトークン無しの URL で開けます。</p>
      <pre><code>http://&lt;ホスト&gt;:&lt;ポート&gt;/?token=&lt;トークン&gt;</code></pre>
      <p class="note">
        トークンの値はサーバーの設定 (<code>LUMISCA_TOKEN</code> / <code>service.env</code>) を確認してください。
        ブラウザが Cookie を拒否している場合もこの画面になります。
      </p>
    </main>
  </body>
</html>`;
}
