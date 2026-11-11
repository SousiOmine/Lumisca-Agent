import type { TodoPhase } from "@lumisca/core/shared";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";
import { TodoPanel } from "./TodoPanel.tsx";

function render(todos: TodoPhase[]): string {
  initLocale("ja");
  return renderToString(createElement(TodoPanel, { todos }));
}

/** One phase whose task ids follow its position, so a render failure names
 * the task instead of a bare index. */
function phase(
  name: string,
  tasks: Array<[string, TodoPhase["tasks"][number]["status"]]>,
  id = name,
): TodoPhase {
  return {
    id,
    name,
    tasks: tasks.map(([taskName, status], index) => ({
      id: `${id}t${index}`,
      name: taskName,
      status,
    })),
  };
}

Deno.test("TodoPanel is a one-line row naming the running task", () => {
  const html = render([
    phase("調査", [
      ["コードを読む", "completed"],
      ["原因を特定する", "in_progress"],
    ]),
    phase("修正", [["テストを直す", "pending"]]),
  ]);

  assertStringIncludes(html, "todo-panel");
  assertStringIncludes(html, "進捗");
  // done/total over the whole plan.
  assertStringIncludes(html, "1/3");
  // The row itself says what is happening; the tasks are in the body, which
  // is mounted but collapsed to no height (styles/motion.css, `.collapse`:
  // a body that is not in the DOM cannot animate closed).
  assertStringIncludes(html, "原因を特定する");
  assertStringIncludes(html, "todo-panel-body");
  assertStringIncludes(html, 'data-open="false"');
  // Collapsed is the only starting state: the row shares the input area's
  // height with the composer.
  assertStringIncludes(html, "todo-panel collapsed");
  assertStringIncludes(html, 'aria-expanded="false"');
});

Deno.test("TodoPanel falls back to no detail when nothing is in progress", () => {
  // Work left to do, but not yet started: the row shows the count only.
  const html = render([
    phase("調査", [
      ["コードを読む", "completed"],
      ["測る", "pending"],
    ]),
  ]);
  assertStringIncludes(html, "1/2");
  assertEquals(html.includes("todo-panel-detail"), false);
});

Deno.test("TodoPanel keeps a plan with work left to do", () => {
  // A blocked task is not settled: the row stays, because the plan is not
  // over.
  const blocked = render([phase("待ち", [["返答を待つ", "blocked"]])]);
  assertStringIncludes(blocked, "todo-panel");

  const pending = render([phase("続き", [["書く", "pending"]])]);
  assertStringIncludes(pending, "todo-panel");
});

Deno.test("TodoPanel leaves the composer alone once the plan is settled", () => {
  // Every task done or dropped: an all-finished plan is read in the
  // transcript, not above the field being typed into.
  assertEquals(
    render([
      phase("調査", [
        ["コードを読む", "completed"],
        ["測る", "abandoned"],
      ]),
      phase("修正", [["直す", "completed"]]),
    ]),
    "",
  );
  assertEquals(render([]), "");
});

Deno.test("TodoPanel counts abandoned tasks in the total but not as done", () => {
  const html = render([
    phase("調査", [
      ["読む", "completed"],
      ["捨てる", "abandoned"],
    ]),
    phase("修正", [["直す", "pending"]]),
  ]);
  assertStringIncludes(html, "1/3");
  assert(html.includes("進捗"));
});
