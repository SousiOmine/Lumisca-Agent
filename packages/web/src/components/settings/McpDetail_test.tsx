import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { McpDetail } from "./McpDetail.tsx";

/** Render the form with stubbed callbacks: the assertions are about what it
 * tells the user, not about the flows it starts. */
function render(saveError: string | null): string {
  initLocale("ja");
  return renderToString(
    createElement(McpDetail, {
      initial: null,
      existingNames: [],
      saveError,
      onSave: () => {},
      onCancel: () => {},
    }),
  );
}

Deno.test("McpDetail reports a failed save inside the form", () => {
  // Pressing save here must never look like a button that does nothing: the
  // reason has to show on this screen, because the list's own error line is
  // not visible while the form is up.
  const html = render("Session is already running: s1");
  assertStringIncludes(html, "保存できませんでした");
  assertStringIncludes(html, "Session is already running: s1");
});

Deno.test("McpDetail shows no save failure until one happened", () => {
  assertEquals(render(null).includes("保存できませんでした"), false);
});
