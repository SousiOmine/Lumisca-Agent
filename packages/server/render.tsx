import { renderToReadableStream } from "react-dom/server";
import { App } from "@lumisca/web/app";
import type { InitialData } from "@lumisca/web/types";

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
 * props) need 'unsafe-inline' for styles. connect-src must name the ws:
 * scheme explicitly ('self' does not cover it).
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/** Assemble the full HTML document around the rendered markup. */
export function renderHtmlDocument(
  markup: string,
  data: InitialData,
  css: string,
): string {
  return `<!doctype html>
<html lang="ja" data-theme="${data.theme}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}" />
    <title>Lumisca Agent</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root">${markup}</div>
    <script type="module" src="/assets/initial-data.js"></script>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;
}
