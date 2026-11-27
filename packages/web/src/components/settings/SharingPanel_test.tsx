import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { SharingPanel } from "./SharingPanel.tsx";

function render(): string {
  initLocale("ja");
  return renderToString(createElement(SharingPanel, {}));
}

test("SharingPanel: a browser has no loan to end and no shell to ask", () => {
  // The page may be served to a plain browser, where folder sharing does not
  // exist. A row that only ever answers "the desktop shell is not available"
  // is worse than no row.
  assertEquals(render(), "");
});

test("SharingPanel: the desktop shell draws the idle choice", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.__LUMISCA_BRIDGE__ = "http://127.0.0.1:9/shell";
  try {
    const html = render();
    assert(html.includes("フォルダー共有"), html);
    assert(html.includes("自動切断"), html);
  } finally {
    delete globals.__LUMISCA_BRIDGE__;
  }
});
