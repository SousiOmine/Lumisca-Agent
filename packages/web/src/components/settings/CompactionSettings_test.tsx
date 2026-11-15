import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { CompactionSettings } from "./CompactionSettings.tsx";

function html(): string {
  return renderToString(createElement(CompactionSettings, {}));
}

Deno.test("the reserve row names what it reserves, with no explanation", () => {
  const panel = html();
  assertStringIncludes(panel, "出力時の予約コンテキスト長（ウィンドウ比 %）");
  // "予約" alone did not say what for, so the row carried a sentence saying
  // it; the label says it now.
  assertEquals(panel.includes("上限に対して残す余裕"), false);
});

Deno.test("the retention share is not a setting any more", () => {
  // It is the compactor's default: a reader had no way to judge 20% against
  // 8%, and the row sat next to a reservation whose meaning is the opposite.
  const panel = html();
  assertEquals(panel.includes("保持（ウィンドウ比 %）"), false);
  assertEquals(panel.includes("圧縮後も残す直近の割合"), false);
});

Deno.test("keeping the compacted log says what it costs", () => {
  const panel = html();
  assertStringIncludes(panel, "圧縮されたログを保持する");
  assertStringIncludes(
    panel,
    "コンテキストが圧縮されたあとも、モデルへの入出力をデータベースに保持します。追加のストレージ容量を必要とします。",
  );
});
