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
  assertStringIncludes(panel, "生成UIの説明を常に含める");
  assertStringIncludes(panel, "トークン使用量が増えます。");
  // The switch's accessible name is the row label, so the two cannot drift.
  assertStringIncludes(panel, 'aria-label="生成UIの説明を常に含める"');
});

test("the identity editor row says where the control appears", () => {
  const panel = html();
  assertStringIncludes(panel, "エージェントのidentityを手動で編集");
  // The switch's own position says whether it is on; the row names where the
  // control appears instead of repeating that.
  assertStringIncludes(
    panel,
    "右クリックメニューにidentityの編集を追加します。",
  );
  assertStringIncludes(
    panel,
    'aria-label="エージェントのidentityを手動で編集"',
  );
});

test("the ask tool row is a label and its switch", () => {
  const panel = html();
  assertStringIncludes(panel, "askツールを無効化");
  // No description on the row: the label alone names what the switch does.
  assertStringIncludes(
    panel,
    '<span class="update-label">askツールを無効化</span></div>',
  );
});
