import { assert, assertEquals } from "@std/assert";
import { messages } from "../packages/core/shared/i18n/messages.ts";
import { checkUiJapanese } from "./check-ui-japanese.ts";

/** Check one synthetic entry and return its rule ids. */
function rulesFor(ja: string): string[] {
  return checkUiJapanese({ "chat.test.one": { ja } }).map(
    (finding) => finding.rule,
  );
}

Deno.test("check-ui-japanese: the catalogue has no findings", () => {
  assertEquals(checkUiJapanese(messages), []);
});

Deno.test("check-ui-japanese: one word per concept", () => {
  assertEquals(rulesFor("フォルダを選ぶ"), ["glossary/folder"]);
  // Already the catalogue's spelling: no finding.
  assertEquals(rulesFor("フォルダーを選ぶ"), []);
  assertEquals(rulesFor("デフォルトに戻す"), ["glossary/default"]);
  assertEquals(rulesFor("ユーザの設定"), ["glossary/user"]);
  assertEquals(rulesFor("サーバの状態"), ["glossary/server"]);
});

Deno.test("check-ui-japanese: a mechanical correction comes with the fix", () => {
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

Deno.test("check-ui-japanese: translated English is called out", () => {
  assertEquals(rulesFor("保存することができます"), ["style/potential"]);
  assertEquals(rulesFor("保存させていただきます"), ["style/humble"]);
  assertEquals(rulesFor("保存して下さい"), ["style/teineigo"]);
  assertEquals(rulesFor("確認を行う"), ["style/okonau"]);
});

Deno.test("check-ui-japanese: plain endings are called out", () => {
  assertEquals(rulesFor("保存する。"), ["style/da"]);
  // ました is polite; it must not look like the plain した.
  assertEquals(rulesFor("保存しました。"), []);
  assertEquals(rulesFor("保存でした。"), []);
});

Deno.test("check-ui-japanese: a sentence gets its closing period", () => {
  assertEquals(rulesFor("接続に成功しました。ツールはありません"), [
    "sentence/unterminated",
  ]);
  // A label whose value follows the colon is not a missing period.
  assertEquals(rulesFor("サーバーが終了しました。終了コード: {code}"), []);
  // Progress text trails off on purpose.
  assertEquals(rulesFor("初回セットアップを行っています。数分かかります…"), []);
});

Deno.test("check-ui-japanese: no parenthetical gloss in a sentence", () => {
  assertEquals(rulesFor("作業内容（タスク）を入力してください。"), [
    "sentence/parentheses",
  ]);
  // A parenthetical that is part of a field name is not a gloss.
  assertEquals(rulesFor("カスタムヘッダー（任意）"), []);
});

Deno.test("check-ui-japanese: the space after a colon may stay", () => {
  // A component concatenates the detail onto this prefix.
  assertEquals(rulesFor("デスクトップシェルと通信できません: "), []);
  assertEquals(rulesFor(" 前の空白"), ["format/edge-space"]);
  assertEquals(rulesFor("後ろの空白 "), ["format/edge-space"]);
});
