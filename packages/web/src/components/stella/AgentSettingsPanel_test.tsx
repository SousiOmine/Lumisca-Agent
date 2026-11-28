import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { AgentSettingsPanel } from "./AgentSettingsPanel.tsx";

function render(open: boolean, agentId: string | null = "a1"): string {
  initLocale("ja");
  return renderToString(
    createElement(AgentSettingsPanel, {
      agentId,
      agentDisabled: false,
      defaultOpen: open,
    }),
  );
}

test("the settings group starts closed and reads no routines", () => {
  // The panel is opened for the screen and the loans too; its settings
  // section must not ask the server for an agent's routines until the reader
  // opens it. The body is therefore absent, not merely hidden.
  const page = render(false);
  assertStringIncludes(page, ">設定<");
  assertStringIncludes(page, ">ルーチン<");
  assertStringIncludes(page, 'aria-expanded="false"');
  assertEquals(page.includes("routine-panel"), false);
  assertEquals(page.includes("stella-agent-routines"), false);
});

test("opening the item draws the same compact list as the dialog", () => {
  // The dialog's body and this one are the same AgentRoutines; only the
  // layout differs, because the panel's column is narrower than the sheet.
  const page = render(true);
  assertStringIncludes(page, 'aria-expanded="true"');
  assertStringIncludes(page, 'id="stella-agent-routines"');
  assertStringIncludes(page, 'class="routine-panel compact"');
});

test("no agent draws no settings group", () => {
  // A pane with nothing picked has no settings to name; an empty heading
  // would be a row the reader cannot use.
  assertEquals(render(false, null), "");
});

test("the MCP item starts closed and reads neither list", () => {
  // Both items are mounted by their disclosure: a closed MCP section must
  // not fetch the two config lists every time the panel is shown.
  const page = render(false);
  assertStringIncludes(page, ">MCPサーバー<");
  assertEquals(page.includes("stella-agent-mcp"), false);
});
