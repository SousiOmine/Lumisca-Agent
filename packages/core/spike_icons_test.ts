import { IconMoon, IconPlus, IconSun } from "@tabler/icons-react";
import { createElement } from "react";

Deno.test("tabler icons render in Deno (SSR)", async () => {
  const { renderToReadableStream } = await import("react-dom/server");
  const stream = await renderToReadableStream(
    createElement(
      "div",
      null,
      createElement(IconPlus, { size: 16 }),
      createElement(IconMoon, { size: 16 }),
      createElement(IconSun, { size: 16 }),
    ),
  );
  const reader = stream.getReader();
  let html = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value);
  }
  if (!html.includes("<svg")) {
    throw new Error(`expected svg output, got: ${html.slice(0, 120)}`);
  }
  if (!html.includes('class="tabler-icon')) {
    throw new Error(`expected tabler-icon class: ${html.slice(0, 200)}`);
  }
});
