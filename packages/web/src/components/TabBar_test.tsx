import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";
import { TabBar, type TabSummary } from "./TabBar.tsx";

/** Render the strip with stubbed callbacks: the assertions are about what
 * one tab shows (label, tooltip, run state), not about the menu flows. */
function render(tabs: TabSummary[]): string {
  initLocale("ja");
  return renderToString(
    createElement(TabBar, {
      tabs,
      onSelect: () => {},
      onClose: () => {},
      onCloseToRight: () => {},
      onCloseToLeft: () => {},
      onCloseOthers: () => {},
      onNew: () => {},
      onOpenRecent: () => {},
      onOpenSettings: () => {},
      isDesktop: true,
      onQuit: () => {},
      onSwitchMode: () => {},
    }),
  );
}

function tab(overrides: Partial<TabSummary> & { id: string }): TabSummary {
  return {
    name: null,
    modelId: null,
    active: false,
    running: false,
    ...overrides,
  };
}

Deno.test("TabBar renders each tab's label, tooltip and active state", () => {
  const html = render([
    tab({
      id: "s1",
      name: "買い物リストの改善",
      modelId: "claude-sonnet-4",
      active: true,
    }),
    // A session created but not yet titled, and not the active tab.
    tab({ id: "s2" }),
  ]);

  assertStringIncludes(html, "買い物リストの改善");
  assertStringIncludes(html, 'title="claude-sonnet-4"');
  // The untitled session falls back to the localized label.
  assertStringIncludes(html, "新しいセッション");
  // Exactly one tab is marked active, and only that one.
  assertEquals(html.match(/aria-selected="true"/g)?.length, 1);
  assertEquals(html.match(/class="tab active"/g)?.length, 1);
});

Deno.test("TabBar marks a running tab and names the tool it runs", () => {
  const html = render([
    tab({ id: "s1", name: "実行中", running: true, runningTool: "bash" }),
    // Running without a tool in flight: the dot shows, the badge does not.
    tab({ id: "s2", name: "待機中", running: true }),
    tab({ id: "s3", name: "停止中" }),
  ]);

  assertEquals(html.match(/class="live-dot"/g)?.length, 2);
  assertStringIncludes(html, '<span class="tab-badge">bash</span>');
  assertEquals(html.match(/class="tab-badge"/g)?.length, 1);
});
