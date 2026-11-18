import { test } from "bun:test";
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

test("the models page shows the two things it is for", () => {
  const page = html();
  assertStringIncludes(page, "既定のモデル");
  assertStringIncludes(page, "利用するモデル");
});

test("everything else waits behind one 詳細, closed", () => {
  // Shown together, the rows that matter read as two among nine. The two
  // come first and the disclosure is last, so what a reader came for is in
  // the first screen and the tuning is below it.
  const page = html();
  const disclosure = at(page, "settings-disclosure-toggle");
  assertEquals(disclosure > at(page, "既定のモデル"), true);
  assertStringIncludes(page, 'aria-expanded="false"');
  assertStringIncludes(page, 'data-open="false"');
  const label = at(page, ">詳細<");
  const list = at(page, "利用するモデル");
  const fast = at(page, "サブタスクで使用するモデル");
  const image = at(page, "画像分析モデル");
  const compaction = at(page, "コンテキスト圧縮");
  assertEquals(disclosure < label, true);
  // 既定のモデル → 利用するモデル → 詳細 (and what it holds).
  assertEquals(at(page, "既定のモデル") < list && list < disclosure, true);
  assertEquals(label < fast && fast < image && image < compaction, true);
});
