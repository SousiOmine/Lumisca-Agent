/**
 * The agent list: each row's second line (what the conversation last said),
 * the create form's optional fields, and the row's ⋮ menu — the only place an
 * agent can be edited or deleted from.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";
import type { StellaAgentSummary } from "../types.ts";
import { StellaSidebar } from "./StellaSidebar.tsx";

/** One row; `preview` says what its conversation last said (`null`: nothing
 * yet). */
function agent(
  id: string,
  preview: StellaAgentSummary["preview"] = null,
): StellaAgentSummary {
  return {
    id,
    name: id === "a1" ? "Aide" : id,
    role: "",
    identity: "",
    icon: "",
    createdAt: 0,
    updatedAt: 0,
    preview,
  };
}

/** A conversation that was spoken in at `at` (2026-09-15 12:00 local). */
const AT = new Date(2026, 8, 15, 12, 0, 0).getTime();

function render(
  agents: StellaAgentSummary[] = [agent("a1", {
    kind: "text",
    text: "3件の不具合を直しました。",
    at: AT,
  })],
  running = false,
): string {
  initLocale("ja");
  return renderToString(
    <StellaSidebar
      agents={agents}
      activeId="a1"
      onSelect={() => {}}
      onChanged={() => {}}
      onAgentChanged={() => {}}
      running={running}
    />,
  );
}

Deno.test("StellaSidebar: a row's second line is what was said last", () => {
  const html = render();
  assertStringIncludes(html, "3件の不具合を直しました。");
  // The name is still there, and the message is the row's faint second line
  // rather than a paragraph of its own.
  assertStringIncludes(html, "stella-agent-label");
  assertStringIncludes(html, "stella-agent-meta");
});

Deno.test("StellaSidebar: a message with no words is described", () => {
  // "3 files" is a caption, not something the user wrote: it comes from the
  // catalogue, so it reads in the app's language.
  assertStringIncludes(
    render([agent("a1", { kind: "files", count: 3, at: AT })]),
    "ファイル 3 件",
  );
  assertStringIncludes(
    render([agent("a1", { kind: "card", at: AT })]),
    "カード",
  );
});

Deno.test("StellaSidebar: a fresh agent is one line", () => {
  // Nothing has been said, so there is no second line and no time to show:
  // a row that invented "まだメッセージはありません" would be a line of text
  // that says nothing.
  const html = render([agent("a1")]);
  assertStringIncludes(html, "Aide");
  assertEquals(html.includes("stella-agent-meta"), false);
  assertEquals(html.includes("stella-agent-time"), false);
});

Deno.test("StellaSidebar: the time is the message's, not the last visit", () => {
  // The regression this pins: the row used to date the agent by when its
  // conversation was OPENED, so a list ordered by recency of speech showed
  // times about the reader.
  const html = render([agent("a1", { kind: "text", text: "はい", at: AT })]);
  const time = html.match(/<time[^>]*>([^<]*)<\/time>/);
  assert(time !== null, "the row has no time");
  // 12:00 on 2026-09-15 is not "just now" whatever the test's clock says, so
  // the value can only have come from the preview's own timestamp.
  assert(/9月|2026|時間前|日前/.test(time[1]!), time[1]);
  assertStringIncludes(time[0], new Date(AT).toISOString());
});

Deno.test("StellaSidebar: the working row says so instead of the message", () => {
  const html = render(undefined, true);
  assertStringIncludes(html, "作業中…");
  // The message is replaced, not repeated: one line says what is happening
  // now, and the dot marks the row for the eye.
  assertEquals(html.includes("3件の不具合を直しました。"), false);
  assertStringIncludes(html, "stella-agent-dot");
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
