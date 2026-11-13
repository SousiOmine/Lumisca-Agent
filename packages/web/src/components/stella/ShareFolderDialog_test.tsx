import { assert, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { ShareFolderDialog } from "./ShareFolderDialog.tsx";

/** The two storage methods the dialog's list uses. */
function memoryStorage(initial: string | null) {
  let value = initial;
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

function withStorage<T>(storage: unknown, run: () => T): T {
  const globals = globalThis as { localStorage?: unknown };
  const before = globals.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      value: before,
      configurable: true,
    });
  }
}

function render(): string {
  initLocale("ja");
  return renderToString(
    createElement(ShareFolderDialog, { sessionId: "s1", onClose: () => {} }),
  );
}

Deno.test("ShareFolderDialog: nothing is lent until a folder is chosen", () => {
  const html = withStorage(memoryStorage(null), render);
  assertStringIncludes(html, "フォルダで共同作業");
  assertStringIncludes(html, "フォルダを選ぶ");
  // A phone shows the dialog full screen, so the backdrop is not a way out:
  // the close button has to be in the sheet whatever state it is in.
  assertStringIncludes(html, "閉じる");
  // The terms and the "share" button belong to a chosen folder: before one
  // exists there is nothing to agree to.
  assert(!html.includes("最後に使ってから30分"), html);
  assert(!html.includes(">貸す<"), html);
  // Nothing was lent before either.
  assert(!html.includes("最近貸したフォルダ"), html);
});

Deno.test("ShareFolderDialog: a recent folder is one press, with its last terms", () => {
  const stored = JSON.stringify([
    { path: "/Users/me/proj", name: "proj", write: true },
    { path: "/Users/me/notes", name: "notes", write: false },
  ]);
  const html = withStorage(memoryStorage(stored), render);
  assertStringIncludes(html, "最近貸したフォルダ");
  assertStringIncludes(html, "proj");
  assertStringIncludes(html, "notes");
  // The terms are the ones saved with the folder, not the dialog's defaults.
  assertStringIncludes(html, "読み書き");
  // The path is there for a reader who has two folders of the same name.
  assertStringIncludes(html, 'title="/Users/me/notes"');
});
