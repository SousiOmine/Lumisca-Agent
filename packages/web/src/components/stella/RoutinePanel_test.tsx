import { assertEquals, assertStringIncludes } from "@std/assert";
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

function html(routines: RoutineView[]): string {
  return renderToString(
    createElement(RoutinePanel, {
      routines,
      loading: false,
      error: null,
      onRefresh: () => {},
      onSetEnabled: () => Promise.resolve(),
      onRun: () => Promise.resolve(),
      onStop: () => Promise.resolve(),
      onDelete: () => Promise.resolve(),
    }),
  );
}

Deno.test("a stopped routine says so on its name's line", () => {
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

Deno.test("a short request is a paragraph, not a disclosure", () => {
  // Only a text past three lines may claim to open something: the element is
  // plain until the row has measured it (the disclosure props come from the
  // measurement, which a server render does not run).
  const page = html([routine()]);
  assertStringIncludes(page, 'class="routine-prompt"');
  assertEquals(page.includes('role="button"'), false);
});
