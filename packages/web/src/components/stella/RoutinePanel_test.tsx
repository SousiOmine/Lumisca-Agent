import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type { RoutineView } from "../../types.ts";
import { RoutinePanel } from "./RoutinePanel.tsx";

function routine(overrides: Partial<RoutineView> = {}): RoutineView {
  return {
    id: "r1",
    agentId: "a1",
    agentName: "Aide",
    name: "Check the deploy",
    prompt: "Check the deploy and report.",
    schedule: { kind: "daily", time: "08:30" },
    enabled: true,
    nextRunAt: 0,
    lastRunAt: null,
    lastStatus: null,
    lastDetail: null,
    createdAt: 0,
    updatedAt: 0,
    running: false,
    queued: false,
    ...overrides,
  };
}

function html(
  routines: RoutineView[],
  agentDisabled = false,
  compact = false,
): string {
  return renderToString(
    createElement(RoutinePanel, {
      routines,
      agentDisabled,
      loading: false,
      error: null,
      onRefresh: () => {},
      onSetEnabled: () => Promise.resolve(),
      onRun: () => Promise.resolve(),
      onStop: () => Promise.resolve(),
      onDelete: () => Promise.resolve(),
      compact,
    }),
  );
}

test("a stopped routine says so on its name's line", () => {
  // The state was the one fact a long name could push out of sight: it
  // wrapped under the name, and the row then read like a running one. The
  // badge is the name's neighbour in the title row, which is what the
  // stylesheet keeps on one line.
  const page = html([routine({ enabled: false })]);
  const title = page.indexOf('class="routine-title"');
  const name = page.indexOf('class="routine-name');
  const badge = page.indexOf("停止中");
  const meta = page.indexOf('class="routine-meta"');
  assertEquals(title >= 0 && name > title, true);
  assertEquals(badge > name && badge < meta, true);
});

test("a short request is a paragraph, not a disclosure", () => {
  // Only a text past three lines may claim to open something: the element is
  // plain until the row has measured it (the disclosure props come from the
  // measurement, which a server render does not run).
  const page = html([routine()]);
  assertStringIncludes(page, 'class="routine-prompt"');
  assertEquals(page.includes('role="button"'), false);
});

test("a disabled agent's routines say they do not run", () => {
  // The list is not hidden: the reader may still be deciding what to keep.
  // What it says is that nothing here fires until the agent is switched on,
  // so a "next 8:30" line is not read as a promise.
  const off = html([routine()], true);
  assertStringIncludes(off, "無効化されているため");
  // The run button is drawn disabled: the server answers 409 for it, and a
  // button that only fails after the press is the worse way to say so.
  const button = off.match(/<button[^>]*>[^<]*<svg[\s\S]*?今すぐ実行/);
  assert(button !== null, "the run button is missing");
  assertStringIncludes(button[0], "disabled");

  // An enabled agent keeps the list as it was.
  const on = html([routine()], false);
  assertEquals(on.includes("無効化されているため"), false);
});

test("the information panel asks for the stacked row", () => {
  // The panel is 240-560px wide whatever the window is, so the same list is
  // drawn in a column there. The variant is a layout choice, not a second
  // list: the rows, the badges and the actions stay the same.
  const panel = html([routine()], false, true);
  assertStringIncludes(panel, 'class="routine-panel compact"');
  assertStringIncludes(html([routine()]), 'class="routine-panel"');
});
