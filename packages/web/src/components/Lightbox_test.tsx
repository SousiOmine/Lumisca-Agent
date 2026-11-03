/**
 * The enlarged picture. What a server-side render can pin: the overlay is a
 * dialog, it names what it shows, and the picture inside it is not itself the
 * thing that closes it (a click that falls through would close it the instant
 * it opened).
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";
import { Lightbox } from "./Lightbox.tsx";

Deno.test("Lightbox: the picture is a dialog the reader can dismiss", () => {
  initLocale("ja");
  const html = renderToString(
    <Lightbox
      src="/api/sessions/s/visual/9f3c2a1b4d5e.png"
      onClose={() => {}}
    />,
  );
  assertStringIncludes(html, 'class="lightbox"');
  // A dialog, not decoration: a reader with a screen reader is told what
  // opened and that it holds the interaction.
  assertStringIncludes(html, 'role="dialog"');
  assertStringIncludes(html, 'aria-modal="true"');
  assertStringIncludes(html, "画像の拡大表示");
  // The picture is drawn whole, from the source it was given.
  assertStringIncludes(html, 'class="lightbox-image"');
  assertStringIncludes(html, 'src="/api/sessions/s/visual/9f3c2a1b4d5e.png"');
});

Deno.test("Lightbox: an alt is carried to the picture", () => {
  initLocale("ja");
  const html = renderToString(
    <Lightbox src="/x.png" alt="screenshot.png" onClose={() => {}} />,
  );
  assertStringIncludes(html, 'alt="screenshot.png"');
  // The label names the file rather than the generic phrase: this is which
  // picture, not just that a picture opened.
  assertStringIncludes(html, 'aria-label="screenshot.png"');
  assertEquals(html.includes("画像の拡大表示"), false);
});
