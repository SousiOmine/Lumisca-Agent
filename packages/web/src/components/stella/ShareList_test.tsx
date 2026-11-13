import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import type { FolderShare } from "../../types.ts";
import { ShareList } from "./ShareList.tsx";

function share(overrides: Partial<FolderShare> = {}): FolderShare {
  return {
    id: "g1",
    name: "proj",
    path: "/Users/me/proj",
    host: { platform: "macos", name: "mac", shell: "zsh" },
    write: false,
    expiresAt: Date.now() + 30 * 60_000,
    ...overrides,
  };
}

function render(shares: readonly FolderShare[]): string {
  initLocale("ja");
  return renderToString(createElement(ShareList, { shares }));
}

Deno.test("ShareList: an empty list draws nothing", () => {
  // The panel's other section (the screen) must not carry an empty heading.
  assertEquals(render([]), "");
});

Deno.test("ShareList: a loan names its address, its folder and its way back", () => {
  const html = render([share()]);
  // The address is what the agent uses; the path is what the user lent.
  assertStringIncludes(html, "/lend/proj");
  assertStringIncludes(html, "/Users/me/proj");
  assertStringIncludes(html, "読み取りのみ");
  assertStringIncludes(html, "切断");
});

Deno.test("ShareList: read-write says so", () => {
  const html = render([share({ write: true })]);
  assertStringIncludes(html, "読み書き");
});
