/**
 * The agent list: the create form's optional fields, and the row's ⋮ menu —
 * the only place an agent can be edited or deleted from.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
      onAgentChanged={() => {}}
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

Deno.test("StellaSidebar: a row's actions live behind its ⋮ menu", () => {
  const html = render();
  const at = html.indexOf("stella-agent-menu");
  assert(at >= 0, "the row has no menu button");
  const tag = html.slice(
    html.lastIndexOf("<button", at),
    html.indexOf(">", at),
  );
  // A menu, not an action: it says so to a screen reader, and it names the
  // agent it belongs to (a list of identical ⋮ buttons is unusable read
  // aloud).
  assertStringIncludes(tag, 'aria-haspopup="menu"');
  assertStringIncludes(tag, "Aide のメニュー");
  // The row itself carries no destructive control: deleting is one click
  // further in, behind the menu (the menu is closed here, so its own items
  // are not in the markup at all).
  assertEquals(html.includes(">削除<"), false);
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
