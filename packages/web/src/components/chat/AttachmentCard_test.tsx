import { test } from "bun:test";
import * as fsSync from "node:fs";
import { assertEquals, assertStringIncludes } from "@std/assert";
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

test("AttachmentCard: an image is drawn from the session's base", () => {
  const html = render([
    {
      name: "9f3c2a1b4d5e.png",
      displayName: "chart.png",
      size: 4096,
      inline: true,
    },
  ]);
  assertStringIncludes(html, `src="${BASE}9f3c2a1b4d5e.png"`);
  assertStringIncludes(html, "msg-attachment-images");
  assertStringIncludes(html, "msg-attachment-image-button");
  // The picture is the control's content, so the CONTROL carries the name
  // (the name the agent found on disk, not the stored one) and the image is
  // marked decorative — announcing both would read the name twice.
  assertStringIncludes(html, 'aria-label="画像の拡大表示: chart.png"');
  // Preact writes an empty `alt` as the bare attribute, which is the same
  // thing to a browser: the image adds nothing to the control's name.
  assertEquals(/<img[^>]*\salt[\s/>]/.test(html), true, html);
  assertEquals(/alt="chart\.png"/.test(html), false, html);
});

test("AttachmentCard: the picture opens in the app, not in a new tab", () => {
  // A new tab would leave the conversation behind and lose the scroll
  // position on the way back; the lightbox is the app's own way of showing
  // one picture whole (see Lightbox).
  const html = render([
    {
      name: "9f3c2a1b4d5e.png",
      displayName: "chart.png",
      size: 4096,
      inline: true,
    },
  ]);
  // A button, not a link.
  assertStringIncludes(html, 'type="button"');
  assertEquals(html.includes("<a"), false, "the picture must not be a link");
  // An agent's block is the shared one, turned to the left.
  assertStringIncludes(html, "msg-attachments agent");
  // The original is asked for, not the downscaled copy the list drew.
  // (Checked on the source, because the lightbox only mounts on a click.)
  const source = fsSync.readFileSync(
    new URL("./AttachmentCard.tsx", import.meta.url),
    "utf8",
  );
  assertStringIncludes(source, "?preview=0");
  const shared = fsSync.readFileSync(
    new URL("./MessageAttachments.tsx", import.meta.url),
    "utf8",
  );
  assertStringIncludes(shared, "<Lightbox");
});

test("AttachmentCard: anything else is a download row", () => {
  const html = render([
    {
      name: "0f1e2d3c4b5a.txt",
      displayName: "run.log",
      size: 1536,
      inline: false,
    },
  ]);
  assertStringIncludes(html, `href="${BASE}0f1e2d3c4b5a.txt"`);
  assertStringIncludes(html, "msg-attachment-file");
  assertStringIncludes(html, 'download="run.log"');
  assertStringIncludes(html, "run.log");
  // The size is shown in the unit a person reads.
  assertStringIncludes(html, "1.5 KB");
  assertStringIncludes(html, "ダウンロード");
});

test("AttachmentCard: no attachment renders no card", () => {
  // An empty list is the normal case (a message with only words): it must
  // not leave an empty frame behind.
  const html = render([]);
  if (html.includes("msg-attachments")) {
    throw new Error(`an empty list must draw nothing: ${html}`);
  }
});
