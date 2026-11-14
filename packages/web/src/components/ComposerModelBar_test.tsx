import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";
import { ComposerModelBar } from "./ComposerModelBar.tsx";

function render(model: { provider: string; modelId: string } | null): string {
  initLocale("ja");
  return renderToString(
    createElement(ComposerModelBar, {
      mode: "picker",
      model,
      onModelSelect: () => {},
      open: false,
      onOpenChange: () => {},
      triggerRef: { current: null },
      popoverRef: { current: null },
      placement: null,
    }),
  );
}

Deno.test("ComposerModelBar names the model in the switch", () => {
  const html = render({ provider: "openai", modelId: "gpt-5" });
  assertStringIncludes(html, "openai/gpt-5");
});

Deno.test("ComposerModelBar's switch carries no live indicator", () => {
  // The pulsing dot belongs to the tab of a running session; a decorative
  // copy here pulsed on a row that is never "working".
  const html = render({ provider: "openai", modelId: "gpt-5" });
  assertEquals(html.includes("live-dot"), false);
});
