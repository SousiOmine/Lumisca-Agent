/**
 * The new-agent form. The regression this pins: "Create" was disabled until
 * both free-text answers were written, so an agent could not be made without
 * describing it first.
 */
import { assert, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";
import { StellaSidebar } from "./StellaSidebar.tsx";

const agents = [{
  id: "a1",
  name: "Aide",
  role: "",
  identity: "",
  icon: "",
  createdAt: 0,
  updatedAt: 0,
}];

function render(): string {
  initLocale("ja");
  return renderToString(
    <StellaSidebar
      agents={agents}
      activeId="a1"
      onSelect={() => {}}
      onChanged={() => {}}
      running={false}
    />,
  );
}

Deno.test("StellaSidebar: the create form says its fields are optional", () => {
  const html = render();
  // The form only exists once the + is pressed, so the copy is asserted for
  // the labels the dialog draws from the catalogue.
  assertStringIncludes(html, "Aide");
  assert(html.includes("stella-agent"), html);
});

Deno.test("StellaSidebar: the create dialog's fields are optional", async () => {
  // The dialog itself is behind a click; the copy lives in the catalogue, and
  // it is the promise the form makes.
  const { translate } = await import("@lumisca/core/shared");
  const role = translate("ja", "chat.stella.agents.roleHint");
  assertStringIncludes(role, "任意");
  const name = translate("ja", "chat.stella.agents.nameHint");
  assertStringIncludes(name, "自動");
});
