import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import type { StellaAgentSummary } from "../../types.ts";
import { AgentRoutinesDialog } from "./AgentRoutinesDialog.tsx";

function agent(): StellaAgentSummary {
  return {
    id: "a1",
    name: "Aide",
    icon: "",
    model: null,
    disabledAt: null,
    createdAt: 0,
    updatedAt: 0,
    preview: null,
  };
}

test("the dialog draws the shared routines body in its wide layout", () => {
  // The information panel adds a second way into the list. It must be the
  // same body, not a copy: the dialog therefore keeps the non-compact row and
  // the panel is the one that asks for the stacked one.
  initLocale("ja");
  const page = renderToString(
    createElement(AgentRoutinesDialog, {
      agent: agent(),
      onClose: () => {},
    }),
  );
  assertStringIncludes(page, "「Aide」のルーチン");
  assertStringIncludes(page, 'class="routine-panel"');
  assertEquals(page.includes("routine-panel compact"), false);
});
