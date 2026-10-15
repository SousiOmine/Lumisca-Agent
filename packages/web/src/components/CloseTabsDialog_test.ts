import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { CloseTabsDialog } from "./CloseTabsDialog.tsx";
import { initLocale } from "../i18n.ts";

/** Render the dialog in the app's original language, so the assertions read
 * as the user sees them. */
function render(names: string[]): string {
  initLocale("ja");
  return renderToString(
    createElement(CloseTabsDialog, {
      names,
      onCancel: () => {},
      onStopAndClose: () => {},
      onKeepRunning: () => {},
    }),
  );
}

Deno.test("CloseTabsDialog warns about the single tab it would stop", () => {
  const html = render(["買い物リストの改善"]);
  assertStringIncludes(html, "実行中のタブを閉じますか？");
  assertStringIncludes(html, "「買い物リストの改善」は実行中です");
  // One name reads in the sentence; there is nothing to list.
  assertEquals(html.includes("confirm-list"), false);
  // All three answers, and nothing else, are offered.
  assertEquals(html.match(/<button/g)?.length, 3);
  for (
    const label of ["キャンセル", "実行を続けて閉じる", "中止して閉じる"]
  ) {
    assertStringIncludes(html, label);
  }
});

Deno.test("CloseTabsDialog lists every running tab of a bulk close", () => {
  const html = render(["A の調査", "B の実装"]);
  assertStringIncludes(html, "対象のタブのうち 2 件が実行中です");
  // The names are rows, not sentence fragments: a title may be long or
  // repeated, and listing them keeps the warning readable.
  assertStringIncludes(html, '<ul class="confirm-list">');
  assertEquals(html.match(/<li>/g)?.length, 2);
  assertStringIncludes(html, "<li>A の調査</li>");
  assertStringIncludes(html, "<li>B の実装</li>");
  assertEquals(html.match(/<button/g)?.length, 3);
});
