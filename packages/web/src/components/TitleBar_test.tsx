/**
 * The window chrome of a Windows / Linux window (undecorated: the page draws
 * the controls), and the one rule that keeps them reachable.
 *
 * `shell.ts` captures the bridge origin and the platform when it loads, so
 * the globals are set first and the module is imported afterwards (the same
 * reason as shellState_test.ts). The platform is a page-load fact, so the
 * macOS case — which branches the other way — lives in its own file
 * (`TitleBarMacos_test.tsx`): one module graph cannot be both windows.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";

const globals = globalThis as unknown as Record<string, unknown>;
globals.__LUMISCA_BRIDGE__ = "http://127.0.0.1:9/shell";
globals.__LUMISCA_PLATFORM__ = "windows";

/** What a bridge whose key gate refused this page answers: an HTTP error,
 * not a transport failure. The window must survive it. */
function refusingBridge(): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "invalid key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

/** Render the bar with the bridge refusing every call. */
async function render(): Promise<string> {
  const { TitleBar } = await import("./TitleBar.tsx");
  initLocale("ja");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = refusingBridge();
  try {
    return renderToString(
      createElement(TitleBar, {
        onNew: () => {},
        onOpenRecent: () => {},
        onOpenSettings: () => {},
        onQuit: () => {},
        onSwitchMode: () => {},
        onManageConnections: () => {},
        mode: "code",
        children: createElement("div", { className: "tabbar" }),
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** The opening tag of the button labelled `label`, or "" when none carries
 * it. Attributes come out in render order, so the tag is found by its label
 * rather than by a fixed position. */
function buttonTag(html: string, label: string): string {
  const at = html.indexOf(`aria-label="${label}"`);
  if (at < 0) return "";
  return html.slice(html.lastIndexOf("<button", at), at);
}

Deno.test("TitleBar: the window controls survive a refused bridge call", async () => {
  // The regression this file exists for. The chrome used to be drawn only
  // once `state` had been read, so a bridge that refused every call took the
  // buttons AND the drag handle down with it: the window (`decorations:
  // false`) could then be neither closed, maximized nor moved — the exact
  // report this test fixes.
  const html = await render();
  assertStringIncludes(html, "titlebar");
  for (const label of ["最小化", "最大化", "閉じる"]) {
    assert(
      buttonTag(html, label) !== "",
      `"${label}" must be drawn without a bridge answer`,
    );
  }
});

Deno.test("TitleBar: the strip is the drag handle", async () => {
  // A refused bridge must leave the window movable too: the drag goes
  // through the strip's own mousedown, which is only wired when the strip
  // renders (see TitleBar's onMouseDown → windowApi.startDrag).
  const html = await render();
  assertStringIncludes(html, 'class="titlebar"');
  // The controls are the bar's right edge; the tab bar takes the rest.
  assertStringIncludes(html, "titlebar-controls");
  assertStringIncludes(html, "tabbar");
});

Deno.test("TitleBar: the connection picker is drawn", async () => {
  // Which server this window shows is the window's own state, so it belongs
  // to the chrome — and it must not disappear with the bridge's answer.
  const html = await render();
  assertStringIncludes(html, "connection-picker");
  assertEquals(buttonTag(html, "最小化") === "", false);
});
