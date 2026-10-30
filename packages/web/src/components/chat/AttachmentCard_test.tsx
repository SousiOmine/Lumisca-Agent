import { assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { AttachmentCard } from "./AttachmentCard.tsx";

const BASE = "/api/sessions/s/attachment/";

function render(
  attachments: Array<{
    name: string;
    displayName: string;
    size: number;
    inline: boolean;
  }>,
): string {
  initLocale("ja");
  return renderToString(
    createElement(AttachmentCard, { attachments, base: BASE }),
  );
}

Deno.test("AttachmentCard: an image is drawn from the session's base", () => {
  const html = render([{
    name: "9f3c2a1b4d5e.png",
    displayName: "chart.png",
    size: 4096,
    inline: true,
  }]);
  assertStringIncludes(html, `src="${BASE}9f3c2a1b4d5e.png"`);
  // The alt text is the name the agent found on disk, not the stored name.
  assertStringIncludes(html, 'alt="chart.png"');
  assertStringIncludes(html, "attach-image");
});

Deno.test("AttachmentCard: anything else is a download row", () => {
  const html = render([{
    name: "0f1e2d3c4b5a.txt",
    displayName: "run.log",
    size: 1536,
    inline: false,
  }]);
  assertStringIncludes(html, `href="${BASE}0f1e2d3c4b5a.txt"`);
  assertStringIncludes(html, 'download="run.log"');
  assertStringIncludes(html, "run.log");
  // The size is shown in the unit a person reads.
  assertStringIncludes(html, "1.5 KB");
  assertStringIncludes(html, "ダウンロード");
});

Deno.test("AttachmentCard: no attachment renders no card", () => {
  // An empty list is the normal case (a message with only words): it must
  // not leave an empty frame behind.
  const html = render([]);
  if (html.includes("attach-card")) {
    throw new Error(`an empty list must draw nothing: ${html}`);
  }
});
