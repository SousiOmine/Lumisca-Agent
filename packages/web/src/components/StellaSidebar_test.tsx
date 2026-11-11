/**
 * The agent list: each row's second line (what the conversation last said),
 * the create form's optional fields, and the row's menu — the only place an
 * agent can be edited or deleted from. The menu has no button now: the row
 * itself carries it, on a right click or a held finger.
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
    icon: "",
    model: null,
    createdAt: 0,
    updatedAt: 0,
    preview,
  };
}

/** A conversation that was spoken in at `at` (2026-09-15 12:00 local). */
const AT = new Date(2026, 8, 15, 12, 0, 0).getTime();

/** Render the list. `loading` is the optional prop the App passes while the
 * first read of the agents is in flight. */
function render(
  agents: StellaAgentSummary[] = [
    agent("a1", {
      kind: "text",
      text: "3件の不具合を直しました。",
      at: AT,
    }),
  ],
  running = false,
  loading?: boolean,
): string {
  initLocale("ja");
  return renderToString(
    <StellaSidebar
      agents={agents}
      activeId="a1"
      onSelect={() => {}}
      onChanged={() => {}}
      onAgentChanged={() => {}}
      onNewAgent={() => {}}
      running={running}
      {...(loading === undefined ? {} : { loading })}
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

Deno.test("StellaSidebar: the working row keeps the message", () => {
  // The regression this pins: a working row replaced the last message with
  // "作業中…", so the one thing the reader was looking at disappeared for as
  // long as the agent worked. The dot says that work is happening; the line
  // keeps saying what was said.
  const html = render(undefined, true);
  assertStringIncludes(html, "3件の不具合を直しました。");
  assertEquals(html.includes("作業中…"), false);
  assertStringIncludes(html, "stella-agent-dot");
});

Deno.test("StellaSidebar: a working row that has said nothing yet stays one line", () => {
  // Nothing was said, so the dot is the only thing to say about the work: an
  // empty second line would be a blank row that claims a message.
  const html = render([agent("a1")], true);
  assertEquals(html.includes("stella-agent-meta"), false);
  assertStringIncludes(html, "stella-agent-dot");
});

Deno.test("StellaSidebar: the face is what identifies a row", () => {
  // 32px read as a badge beside the name rather than as the face the reader
  // scans down. 40 gives the two lines a face of their own height without
  // turning the row into a profile header (the conversation's header keeps
  // its 22: that strip is one line tall).
  const html = render();
  assertStringIncludes(html, "width:40px;height:40px");
});

Deno.test("StellaSidebar: the row itself is what opens its menu", () => {
  const html = render();
  // Regression: every row carried a ⋮ beside the name, drawn on hover and
  // always on touch. It competed with the name for attention, and the row's
  // two verbs (edit, delete) are the browser's context-menu verbs already.
  assertEquals(html.includes("stella-agent-menu"), false);
  assertEquals(html.includes("のメニュー"), false);
  // The row still carries no destructive control of its own: deleting is
  // behind the menu, which is closed here and so not in the markup at all.
  assertEquals(html.includes(">削除<"), false);

  const source = Deno.readTextFileSync(
    new URL("./StellaSidebar.tsx", import.meta.url),
  );
  // A mouse's right click opens it...
  assertStringIncludes(source, "onContextMenu=");
  // ...and a phone, which has no right click, holds the row instead. A press
  // shorter than the wait is still a tap, so it opens the conversation as it
  // always did.
  assertStringIncludes(source, "onPointerDown=");
  assertStringIncludes(source, "LONG_PRESS_MS");
  assertStringIncludes(source, 'event.pointerType === "mouse"');
  // The click a lifting finger still sends ends that press: without this it
  // would open the conversation under the menu the press just opened.
  assertStringIncludes(source, "onClickCapture=");
  // A keyboard has neither gesture; its menu key and Shift+F10 open the same
  // menu on the row.
  assertStringIncludes(source, 'event.key === "ContextMenu"');
  assertStringIncludes(source, 'event.key === "F10"');
});

Deno.test("StellaSidebar: the empty list is not shown while it is being read", () => {
  // An empty list and a list still on its way look the same on screen, and
  // the empty state's advice ("create one") is wrong for half of them: the
  // wait is said instead until the read settles.
  const waiting = render([], false, true);
  assertStringIncludes(waiting, "読み込み中");
  assertEquals(
    waiting.includes("登録されているエージェントがありません"),
    false,
  );

  // Settled with nothing: the empty state (and its advice) is now the truth.
  const empty = render([], false, false);
  assertStringIncludes(empty, "登録されているエージェントがありません");
  assertEquals(empty.includes("読み込み中"), false);

  // A list with rows is drawn as rows whether a read is in flight or not: a
  // refresh must never replace real content with the wait.
  assertStringIncludes(render(undefined, false, true), "Aide");
});

Deno.test("StellaSidebar: the create dialog asks for the job, and names it later", async () => {
  // The dialog itself is behind a click; the copy lives in the catalogue, and
  // it is the promise the form makes. The ONE required answer is what the
  // agent should do; how it works is asked by the agent itself, in the
  // conversation (see stella/onboarding.ts).
  const { translate } = await import("@lumisca/core/shared");
  assertStringIncludes(
    translate("ja", "chat.stella.agents.role"),
    "してほしい",
  );
  // A name can be decided later, and the field says so.
  assertStringIncludes(translate("ja", "chat.stella.agents.nameHint"), "自動");
  // The examples are sentences the user can edit in the same field — not
  // labels hiding a prompt. Each names a job on its own.
  for (const key of [
    "chat.stella.agents.preset.secretaryText",
    "chat.stella.agents.preset.bookkeepingText",
    "chat.stella.agents.preset.researchText",
    "chat.stella.agents.preset.travelText",
  ] as const) {
    assert(translate("ja", key).length > 20, key);
  }
});

Deno.test("StellaSidebar: the row menu is placed from the left edge", () => {
  // Regression: the menu was anchored to the viewport's RIGHT edge, so a
  // right click near the left edge (the sidebar IS the left edge) pushed the
  // menu off the screen. It is drawn from the point it was opened at, and
  // that point is measured against the left edge.
  const source = Deno.readTextFileSync(
    new URL("./StellaSidebar.tsx", import.meta.url),
  );
  // The anchor stores a left offset, not a right one.
  assertStringIncludes(source, "x: number;");
  assertEquals(
    /right: globalThis\.innerWidth - /.test(source),
    false,
    "the menu must not be anchored to the right edge",
  );
  // It is clamped to the window after it renders: a constant would be wrong,
  // because the menu sizes itself to its items and to the language.
  assertStringIncludes(source, "getBoundingClientRect();");
  assertStringIncludes(source, "globalThis.innerWidth - rect.width");
  assertStringIncludes(source, "globalThis.innerHeight - rect.height");
  // And it is drawn from that measurement, hidden until it lands.
  assertStringIncludes(source, "left: pos?.x ?? menu.x");
  assertStringIncludes(source, 'pos === null ? "hidden" : "visible"');
});

Deno.test("StellaSidebar: a created agent is in the list before it is opened", () => {
  // Regression: 作成 closed the dialog and left the screen on the list. The
  // selection was made first, and the App sends an address naming an agent
  // its list cannot find back to the list — a new agent is exactly that
  // until the list is re-read, and a re-read cannot land before the
  // selection does. The create's answer carries the row, so it reaches the
  // list first.
  //
  // The dialog is the App's (the title bar opens the same one at phone
  // widths), so the two steps are in two files: the dialog hands over only
  // the row the server answered, and the App puts it into the list before it
  // moves the address.
  const dialog = Deno.readTextFileSync(
    new URL("./stella/AgentCreateDialog.tsx", import.meta.url),
  );
  assertStringIncludes(dialog, "onCreated(agent)");
  const app = Deno.readTextFileSync(new URL("../App.tsx", import.meta.url));
  const start = app.indexOf("agentCreate={");
  const body = app.slice(start, app.indexOf("agentEdit={", start));
  const row = body.indexOf("stella.applyAgent(agent)");
  const selection = body.indexOf("goToStellaAgent(agent.id)");
  assert(row >= 0, "the create's answer must reach the list");
  assert(selection > row, "the row must be in the list before it is named");
  // A re-read is not what puts it there: that would be a second answer to a
  // question already answered, and it arrives too late.
  assertEquals(body.includes("reloadAgents"), false);
});
