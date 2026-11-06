/**
 * The title bar in a plain browser: no shell, so no window chrome.
 *
 * `shell.ts` captures the bridge origin when it loads, so this file leaves
 * both globals unset and imports the module afterwards (the same reason as
 * shellState_test.ts). A desktop window is the other branch of the same
 * rule, tested in `TitleBar_test.tsx`.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";

const { TitleBar } = await import("./TitleBar.tsx");

Deno.test("TitleBar: a plain browser gets the tab bar and no window chrome", () => {
  initLocale("ja");
  const html = renderToString(
    createElement(TitleBar, {
      onNew: () => {},
      onOpenRecent: () => {},
      onOpenSettings: () => {},
      onQuit: () => {},
      onSwitchMode: () => {},
      onManageConnections: () => {},
      children: createElement("div", { className: "tabbar" }),
    }),
  );
  // The tab bar is drawn on its own: there is no shell window to drive, and
  // the tab bar keeps its default (full bar) styles without `.titlebar`.
  assertStringIncludes(html, "tabbar");
  assertEquals(html.includes("titlebar"), false);
  assertEquals(html.includes("connection-picker"), false);
});
