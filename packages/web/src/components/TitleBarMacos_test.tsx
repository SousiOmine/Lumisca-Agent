/**
 * The window chrome of a macOS window, and of a plain browser.
 *
 * Both cases need their own module graph: `shell.ts` captures the bridge
 * origin and the platform once, when it loads. So the Windows / Linux case
 * lives in `TitleBar_test.tsx` and these two here — one file cannot be both
 * a macOS window and a browser page.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";

const globals = globalThis as unknown as Record<string, unknown>;
globals.__LUMISCA_BRIDGE__ = "http://127.0.0.1:9/shell";
globals.__LUMISCA_PLATFORM__ = "macos";

const { TitleBar } = await import("./TitleBar.tsx");

function render(): string {
  initLocale("ja");
  return renderToString(
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
}

/** The opening tag of the button labelled `label`, or "" when none carries
 * it. */
function buttonTag(html: string, label: string): string {
  const at = html.indexOf(`aria-label="${label}"`);
  if (at < 0) return "";
  return html.slice(html.lastIndexOf("<button", at), at);
}

Deno.test("TitleBar: macOS leaves the window buttons to the window server", () => {
  // `tauri.macos.conf.json` keeps `decorations` + `titleBarStyle: overlay`,
  // so the traffic lights are the OS's. A drawn set would be a second one in
  // a different style, under the native bar.
  const html = render();
  assertStringIncludes(html, "titlebar");
  for (const label of ["最小化", "最大化", "閉じる"]) {
    assertEquals(
      buttonTag(html, label),
      "",
      `macOS must not draw "${label}"`,
    );
  }
});

Deno.test("TitleBar: macOS still carries the picker and the app menu", () => {
  // What macOS *does* keep: the strip is the window's toolbar, so the server
  // it shows and the menu stay reachable there.
  const html = render();
  assertStringIncludes(html, "connection-picker");
  assertStringIncludes(html, "titlebar-controls");
});
