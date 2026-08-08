import { renderToReadableStream } from "react-dom/server";
import { App } from "@lumisca/web/app";
import type { InitialData } from "@lumisca/web/types";
import { VITE_HMR_PORT } from "./vite-dev.ts";

/** Server-render the React app and return the markup for `#root`. */
export async function renderAppMarkup(data: InitialData): Promise<string> {
  const stream = await renderToReadableStream(<App initialData={data} />);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

/**
 * Content-Security-Policy for the SSR page. Inline scripts are banned, so
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

/**
 * Dev-mode CSP: Vite's fast-refresh preamble is an inline module script and
 * the HMR websocket lives on Vite's own port, so both need relaxing.
 */
export const PAGE_CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  `connect-src 'self' ws://127.0.0.1:${VITE_HMR_PORT} ws://localhost:${VITE_HMR_PORT} ws://127.0.0.1:* ws://localhost:* http://lumisca.localhost`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

export interface HtmlDocumentOptions {
  /** Dev mode: styles and the client entry are served by Vite instead of
   * being inlined / bundled with esbuild. */
  dev?: boolean;
  /** Auth token for the UI. In prod it is served via /assets/initial-data.js
   * (CSP bans inline scripts) — the script URL then carries `?token=` so
   * the guarded asset can be fetched. Dev inlines it because Vite's HTML
   * transform cannot resolve that URL. */
  token?: string;
  /** The page's own host (Host header), used by the CSP to name the
   * WebSocket endpoint when the page is served remotely. */
  pageHost?: string;
}

/** Assemble the full HTML document around the rendered markup. */
export function renderHtmlDocument(
  markup: string,
  data: InitialData,
  css: string,
  options: HtmlDocumentOptions = {},
): string {
  const dev = options.dev === true;
  const style = dev
    ? `<link rel="stylesheet" href="/src/styles.css" />`
    : `<style>${css}</style>`;
  const appScript = dev
    ? `<script type="module" src="/src/client.tsx"></script>`
    : `<script type="module" src="/assets/app.js"></script>`;
  // `<` is escaped so the JSON can never close the script tag.
  const safeData = JSON.stringify(data).replace(/</g, "\\u003c");
  const dataScript = dev
    ? `<script type="module">window.__INITIAL_DATA__ = ${safeData};${
      options.token === undefined
        ? ""
        : `\nwindow.__LUMISCA_TOKEN__ = ${JSON.stringify(options.token)};`
    }</script>`
    : `<script type="module" src="/assets/initial-data.js${
      options.token === undefined
        ? ""
        : `?token=${encodeURIComponent(options.token)}`
    }"></script>`;
  return `<!doctype html>
<html lang="ja" data-theme="${data.theme}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${
    dev ? PAGE_CSP_DEV : pageCsp(options.pageHost)
  }" />
    <title>Lumisca Agent</title>
    ${style}
  </head>
  <body>
    <div id="root">${markup}</div>
    ${dataScript}
    ${appScript}
  </body>
</html>`;
}
