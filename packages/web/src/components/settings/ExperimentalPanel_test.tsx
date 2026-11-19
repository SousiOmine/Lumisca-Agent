import { test } from "bun:test";
import { assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { ExperimentalPanel } from "./ExperimentalPanel.tsx";

function html(): string {
  return renderToString(createElement(ExperimentalPanel, {}));
}

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
