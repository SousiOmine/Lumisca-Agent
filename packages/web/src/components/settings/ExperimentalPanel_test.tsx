import { test } from "bun:test";
import { assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { ExperimentalPanel } from "./ExperimentalPanel.tsx";

function html(): string {
  return renderToString(createElement(ExperimentalPanel, {}));
}

test("the code mode row says what the switch gates", () => {
  const panel = html();
  assertStringIncludes(panel, "Lumisca codeを有効化");
  assertStringIncludes(panel, "Lumisca codeを開けるようにします。");
  // The switch's accessible name is the row label, so the two cannot drift.
  assertStringIncludes(panel, 'aria-label="Lumisca codeを有効化"');
});

test("the app UI prompt row says what it does and what it costs", () => {
  const panel = html();
  assertStringIncludes(panel, "生成UIのプロンプト処理を強化");
  assertStringIncludes(
    panel,
    "生成UIの説明を既定で読み込むことで、生成UIの使用を促進します。トークン使用量が増加します。",
  );
  // The switch's accessible name is the row label, so the two cannot drift.
  assertStringIncludes(panel, 'aria-label="生成UIのプロンプト処理を強化"');
});

test("the ask tool row is a label and its switch", () => {
  const panel = html();
  assertStringIncludes(panel, "askツールを無効化");
  // No description on the row: the page note already says what a switch on
  // this page means, and the request asked for the label alone.
  assertStringIncludes(
    panel,
    '<span class="update-label">askツールを無効化</span></div>',
  );
});
