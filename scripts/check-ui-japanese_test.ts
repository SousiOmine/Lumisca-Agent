import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { messages } from "../packages/core/shared/i18n/messages.ts";
import { checkUiJapanese } from "./check-ui-japanese.ts";

/** Check one synthetic entry and return its rule ids. */
function rulesFor(ja: string): string[] {
  return checkUiJapanese({ "chat.test.one": { ja } }).map(
    (finding) => finding.rule,
  );
}

test("check-ui-japanese: the catalogue has no findings", () => {
  assertEquals(checkUiJapanese(messages), []);
});

test("check-ui-japanese: one word per concept", () => {
  assertEquals(rulesFor("フォルダを選ぶ"), ["glossary/folder"]);
  // Already the catalogue's spelling: no finding.
  assertEquals(rulesFor("フォルダーを選ぶ"), []);
  assertEquals(rulesFor("デフォルトに戻す"), ["glossary/default"]);
  assertEquals(rulesFor("ユーザの設定"), ["glossary/user"]);
  assertEquals(rulesFor("サーバの状態"), ["glossary/server"]);
});

test("check-ui-japanese: a mechanical correction comes with the fix", () => {
  const [finding] = checkUiJapanese({
    "chat.test.one": { ja: "フォルダを選ぶ" },
  });
  assert(finding !== undefined);
  assertEquals(finding.fixed, "フォルダーを選ぶ");

  const [ellipsis] = checkUiJapanese({
    "chat.test.one": { ja: "メッセージを入力..." },
  });
  assert(ellipsis !== undefined);
  assertEquals(ellipsis.fixed, "メッセージを入力…");
});

test("check-ui-japanese: translated English is called out", () => {
  assertEquals(rulesFor("保存することができます"), ["style/potential"]);
  assertEquals(rulesFor("保存させていただきます"), ["style/humble"]);
  assertEquals(rulesFor("保存して下さい"), ["style/teineigo"]);
  assertEquals(rulesFor("確認を行う"), ["style/okonau"]);
});

test("check-ui-japanese: plain endings are called out", () => {
  assertEquals(rulesFor("保存する。"), ["style/da"]);
  // ました is polite; it must not look like the plain した.
  assertEquals(rulesFor("保存しました。"), []);
  assertEquals(rulesFor("保存でした。"), []);
});

test("check-ui-japanese: a sentence gets its closing period", () => {
  assertEquals(rulesFor("接続に成功しました。ツールはありません"), [
    "sentence/unterminated",
  ]);
  // A label whose value follows the colon is not a missing period.
  assertEquals(rulesFor("サーバーが終了しました。終了コード: {code}"), []);
  // Progress text trails off on purpose.
  assertEquals(rulesFor("初回セットアップを行っています。数分かかります…"), []);
});

test("check-ui-japanese: no parenthetical gloss in a sentence", () => {
  assertEquals(rulesFor("作業内容（タスク）を入力してください。"), [
    "sentence/parentheses",
  ]);
  // A parenthetical that is part of a field name is not a gloss.
  assertEquals(rulesFor("カスタムヘッダー（任意）"), []);
});

test("check-ui-japanese: the space after a colon may stay", () => {
  // A component concatenates the detail onto this prefix.
  assertEquals(rulesFor("デスクトップシェルと通信できません: "), []);
  assertEquals(rulesFor(" 前の空白"), ["format/edge-space"]);
  assertEquals(rulesFor("後ろの空白 "), ["format/edge-space"]);
});

test("check-ui-japanese: no space between scripts or a number", () => {
  // The catalogue writes a Latin word, a number and a placeholder on the
  // Japanese around it with no space: the reader's eye crosses the boundary
  // either way, and a space there breaks the word in two.
  assertEquals(rulesFor("PWA 通知"), ["format/space-between-scripts"]);
  assertEquals(rulesFor("この PC の"), ["format/space-between-scripts"]);
  assertEquals(rulesFor("1 件の質問"), ["format/space-between-scripts"]);
  assertEquals(rulesFor("履歴 {count} 件"), ["format/space-between-scripts"]);
  assertEquals(rulesFor("PWA通知"), []);
  assertEquals(rulesFor("このPCの"), []);
  assertEquals(rulesFor("1件の質問"), []);
  assertEquals(rulesFor("履歴{count}件"), []);
  // A space between two Latin words, or around a slash, is not that boundary.
  assertEquals(rulesFor("iPhone / iPad"), []);
  assertEquals(rulesFor("Lumisca code"), []);
});

test("check-ui-japanese: the space fix is mechanical", () => {
  const [finding] = checkUiJapanese({
    "chat.test.one": { ja: "履歴 {count} 件を要約しました。" },
  });
  assert(finding !== undefined);
  assertEquals(finding.fixed, "履歴{count}件を要約しました。");
});
