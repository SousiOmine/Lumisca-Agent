import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import type { StellaAgentSummary } from "../../types.ts";
import { AgentIdentityDialog } from "./AgentIdentityDialog.tsx";

/**
 * The identity editor a row's menu opens.
 *
 * The read happens in an effect, and this renderer does not run effects, so
 * these cover the state the dialog opens in: the field is there, it is not
 * editable until the stored text arrives, and the sentences that say what the
 * text is and when a change reaches the conversation are shown.
 */

const agent: StellaAgentSummary = {
  id: "a1",
  name: "Aide",
  icon: "",
  model: null,
  disabledAt: null,
  createdAt: 0,
  updatedAt: 0,
  preview: null,
};

function render(target: StellaAgentSummary = agent): string {
  initLocale("ja");
  return renderToString(
    createElement(AgentIdentityDialog, {
      agent: target,
      onClose: () => {},
    }),
  );
}

test("AgentIdentityDialog: the heading names the agent", () => {
  assertStringIncludes(render(), "「Aide」のidentity");
});

test("AgentIdentityDialog: the field is one text area, closed until the read lands", () => {
  const html = render();
  const field = /<textarea[^>]*>/.exec(html)?.[0];
  assertEquals(typeof field, "string");
  // The limit is the core's, and the browser enforces the same number before
  // the server has to refuse an over-long text.
  assertStringIncludes(field ?? "", 'maxlength="4000"');
  // Nothing is editable (or saveable) before the stored text is known: a save
  // from an empty field would replace a note the user never saw.
  assertStringIncludes(field ?? "", "disabled");
  assertStringIncludes(render(), 'aria-label="identity"');
});

test("AgentIdentityDialog: it says what the text is and what an empty save does", () => {
  const html = render();
  assertStringIncludes(html, "エージェントが自分について書いた文章です。");
  assertStringIncludes(html, "空にして保存すると削除されます。");
});

test("AgentIdentityDialog: it says when a saved change reaches the conversation", () => {
  // The prompt is fixed when it is generated, so the open conversation keeps
  // the old text. A dialog that did not say so would look like it failed.
  assertStringIncludes(render(), "履歴の圧縮のあとに反映されます。");
});

test("AgentIdentityDialog: the counter starts at zero", () => {
  assertStringIncludes(render(), "0/4000");
});
