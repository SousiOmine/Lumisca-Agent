import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { SetupScreen } from "./SetupScreen.tsx";

function render(desktop: boolean): string {
  initLocale("ja");
  return renderToString(
    createElement(SetupScreen, {
      desktop,
      theme: "dark",
      themeError: null,
      onThemeChange: () => {},
      language: "ja",
      languageError: null,
      onLanguageChange: () => {},
      busy: false,
      error: null,
      onComplete: async () => {},
    }),
  );
}

test("the desktop setup opens on the connection screen, with no step count", () => {
  const html = render(true);
  assertStringIncludes(html, "サーバーに接続");
  // The gate is not step 1 of 5: a reader who connects to another server
  // never walks the four, so the header does not count them here.
  assertEquals(html.includes("ステップ1 / 4"), false);
  assertEquals(html.includes('class="setup-actions"'), false);
});

test("a browser setup starts on the local walk", () => {
  const html = render(false);
  assertStringIncludes(html, "言語とテーマ");
  assertStringIncludes(html, "ステップ1 / 4");
  assertEquals(html.includes("サーバーに接続"), false);
});
