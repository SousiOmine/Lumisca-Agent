import { renderToReadableStream } from "npm:react-dom@19/server";
import { App } from "../web/src/App.tsx";
import type { InitialData } from "../web/src/types.ts";

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

/** Assemble the full HTML document around the rendered markup. */
export function renderHtmlDocument(
  markup: string,
  data: InitialData,
  css: string,
): string {
  const safeData = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ja" data-theme="${data.theme}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lumisca Agent</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root">${markup}</div>
    <script>window.__INITIAL_DATA__ = ${safeData};</script>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;
}
