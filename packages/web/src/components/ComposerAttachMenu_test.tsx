import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import {
  AttachMenuPanel,
  type ComposerAttachAction,
} from "./ComposerAttachMenu.tsx";

/**
 * The plus menu's rows.
 *
 * Worth pinning is the markup the stylesheet and a screen reader both read:
 * the surface is a `menu`, every row is a `menuitem` (a button, so it can
 * take the focus and be activated from the keyboard), and the row class the
 * sheet draws is `.attach-item`. The trigger's own state (open/closed,
 * closing on an outside click) is a hook, not markup, and is checked by
 * using the composer.
 */

function action(id: string, label: string): ComposerAttachAction {
  return { id, label, icon: () => null, run: () => {} };
}

function draw(actions: ComposerAttachAction[]): string {
  return renderToString(
    createElement(AttachMenuPanel, { actions, onSelect: () => {} }),
  );
}

Deno.test("AttachMenuPanel: the rows are a menu of menu items", () => {
  const html = draw([action("attach", "画像を添付")]);
  assertStringIncludes(html, 'class="attach-popover"');
  assertStringIncludes(html, 'role="menu"');
  assertStringIncludes(html, 'class="attach-item"');
  assertStringIncludes(html, 'role="menuitem"');
  assertStringIncludes(html, 'class="attach-item-label">画像を添付<');
});

Deno.test("AttachMenuPanel: the rows keep the order they were given", () => {
  // The composer decides the order (composerMenuItems); the panel must not
  // rearrange it.
  const html = draw([
    action("attach", "画像を添付"),
    action("command", "コマンド"),
    action("file", "ファイルを指定"),
  ]);
  const labels = [...html.matchAll(/attach-item-label">([^<]*)</g)].map(
    (match) => match[1],
  );
  assertEquals(labels, ["画像を添付", "コマンド", "ファイルを指定"]);
  assertEquals([...html.matchAll(/role="menuitem"/g)].length, 3);
});

Deno.test("AttachMenuPanel: a row is a button, not a link", () => {
  // It runs an action on the same page (open the picker, insert a trigger),
  // so it must not be a navigation target.
  const html = draw([action("attach", "画像を添付")]);
  assertStringIncludes(html, "<button");
  assert(!html.includes("<a "), "a menu row must not be a link");
  assertStringIncludes(html, 'type="button"');
});
