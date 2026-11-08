import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import type { StellaAgentSummary } from "../../types.ts";
import { AgentEditDialog } from "./AgentEditDialog.tsx";

/**
 * The agent edit form: what it offers, and what it deliberately does not.
 *
 * The dialog is the only place an agent's name, picture or model can be
 * changed, so what is checked here is the promise it makes: the fields are
 * there, they are saved together, and the role (which the agent works from and
 * which a rename must not touch) has no field at all.
 */

const agent: StellaAgentSummary = {
  id: "a1",
  name: "Aide",
  icon: "",
  model: null,
  createdAt: 0,
  updatedAt: 0,
  preview: null,
};

function render(target: StellaAgentSummary = agent): string {
  initLocale("ja");
  return renderToString(
    createElement(AgentEditDialog, {
      agent: target,
      onChanged: () => {},
      onClose: () => {},
    }),
  );
}

Deno.test("AgentEditDialog: the name is a field with its current value", () => {
  const html = render();
  assertStringIncludes(html, "「Aide」を編集");
  // The field starts with what the agent is called now: editing is a change
  // to a value, not retyping one.
  assert(/<input[^>]*value="Aide"/.test(html), html);
});

Deno.test("AgentEditDialog: the role is not editable here", () => {
  const html = render();
  // The role is the instruction the agent works from and is baked into its
  // session's system prompt, so a field for it would promise a change that
  // never reaches a conversation that already exists.
  assertEquals(html.includes("You keep notes."), false);
  assertEquals(html.includes("役割"), false);
});

Deno.test("AgentEditDialog: an agent without a picture offers no reset", () => {
  // A control that removes something which is not there is one more thing to
  // read (and it would be a no-op the user has to interpret).
  assertEquals(render().includes("デフォルトに戻す"), false);
  assertStringIncludes(
    render({ ...agent, icon: "9f3c2a1b4d5e.png" }),
    "デフォルトに戻す",
  );
});

Deno.test("AgentEditDialog: saving is one action for both fields", () => {
  const html = render();
  // One primary button: the name and the picture travel in one request, so
  // there is no "save name" beside a picture that saves itself.
  assertStringIncludes(html, "保存");
  assertStringIncludes(html, "キャンセル");
  // The picture's own controls are secondary (choose / reset), never primary:
  // choosing a file is not a commit.
  assertEquals((html.match(/btn primary/g) ?? []).length, 1);
});

Deno.test("AgentEditDialog: an agent without a model follows the default", () => {
  const html = render();
  // Unset is a state to show, not an empty row: the sentence the user needs
  // is that this agent runs on whatever the app's default model is.
  assertStringIncludes(html, "既定のモデル");
  // Nothing to return to, so no control that does it (the same rule as the
  // picture's reset).
  assertEquals(html.includes("既定に戻す"), false);
});

Deno.test("AgentEditDialog: a chosen model is shown and can be cleared", () => {
  const html = render({
    ...agent,
    model: { provider: "faux", modelId: "large" },
  });
  assertStringIncludes(html, "faux/large");
  // Returning to the default is how a user undoes the choice — the dialog
  // must offer it without deleting the agent.
  assertStringIncludes(html, "既定に戻す");
});
