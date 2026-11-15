import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { ModelsPage } from "./ModelsPage.tsx";

function html(): string {
  return renderToString(
    createElement(ModelsPage, { onOpenProviders: () => {} }),
  );
}

/** Where `needle` sits in the rendered page, or -1. */
function at(page: string, needle: string): number {
  return page.indexOf(needle);
}

Deno.test("the models page shows the two things it is for", () => {
  const page = html();
  assertStringIncludes(page, "既定のモデル");
  assertStringIncludes(page, "利用するモデル");
});

Deno.test("everything else waits behind one 詳細, closed", () => {
  // Shown together, the rows that matter read as two among nine.
  const page = html();
  const disclosure = at(page, "settings-disclosure-toggle");
  assertEquals(disclosure > at(page, "既定のモデル"), true);
  assertStringIncludes(page, 'aria-expanded="false"');
  assertStringIncludes(page, 'data-open="false"');
  // The label, then the rows it holds, then the list of models: one
  // disclosure for the page, so the open body is read in that order.
  const label = at(page, ">詳細<");
  const fast = at(page, "サブタスクで使用するモデル");
  const image = at(page, "画像分析モデル");
  const compaction = at(page, "コンテキスト圧縮");
  const list = at(page, "利用するモデル");
  assertEquals(disclosure < label, true);
  assertEquals(label < fast && fast < image && image < compaction, true);
  assertEquals(compaction < list, true);
});
