import { test } from "bun:test";
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

test("ShareList: an empty list draws nothing", () => {
  // The panel's other section (the screen) must not carry an empty heading.
  assertEquals(render([]), "");
});

test("ShareList: a loan names its address, its folder and its way back", () => {
  const html = render([share()]);
  // The address is what the agent uses; the path is what the user lent.
  assertStringIncludes(html, "/lend/proj");
  assertStringIncludes(html, "/Users/me/proj");
  assertStringIncludes(html, "読み取りのみ");
  assertStringIncludes(html, "切断");
});

test("ShareList: read-write says so", () => {
  const html = render([share({ write: true })]);
  assertStringIncludes(html, "読み書き");
});

test("ShareList: a whole-computer loan is one frame with one way out", () => {
  const html = render([
    share({ id: "g1", name: "c", path: "C:\\", group: "pc-1" }),
    share({ id: "g2", name: "d", path: "D:\\", group: "pc-1" }),
  ]);
  // Two drives, one loan: the frame says which loan it is, and each place
  // keeps the address the agent uses.
  assertStringIncludes(html, "このパソコン全体");
  assertStringIncludes(html, "/lend/c");
  assertStringIncludes(html, "/lend/d");
  assertStringIncludes(html, "C:\\");
  assertStringIncludes(html, "D:\\");
  // One withdrawal takes both, and no per-place button sits inside the loan.
  assertEquals((html.match(/まとめて切断/g) ?? []).length, 1);
  assertEquals(html.includes(">切断<"), false);
});
