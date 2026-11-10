import { assertEquals } from "@std/assert";
import { markdownToText, notificationText } from "./markdown-text.ts";

/**
 * A reply's markdown as notification text.
 *
 * A toast has no renderer, so every mark left in the text is shown to the
 * reader literally. These cases are the shapes a reply actually uses; the
 * point is not to parse markdown (the screen does that) but to keep the
 * words and drop the punctuation of the format.
 */

Deno.test("markdown's block marks become the lines they decorate", () => {
  assertEquals(
    markdownToText(
      "# 見出し\n\n本文です。\n\n## 小見出し\n\n- 一つ\n- 二つ\n\n1. 先\n2. 後\n\n> 引用\n\n---",
    ),
    "見出し\n本文です。\n小見出し\n・一つ\n・二つ\n1. 先\n2. 後\n引用",
  );
});

Deno.test("inline marks are removed, their words kept", () => {
  assertEquals(
    markdownToText(
      "**太字**と*斜体*と`code`と~~消し~~と[リンク](https://example.com/a)と![図](https://example.com/a.png)",
    ),
    "太字と斜体とcodeと消しとリンクと図",
  );
});

Deno.test("a fence keeps its code and drops its markers", () => {
  assertEquals(
    markdownToText("前\n\n```ts\nconst a = 1; // **literal**\n```\n\n後"),
    "前\nconst a = 1; // **literal**\n後",
  );
});

Deno.test("a table becomes its cells", () => {
  assertEquals(
    markdownToText("| 名前 | 値 |\n| --- | ---: |\n| a | 1 |"),
    "名前 値\na 1",
  );
});

Deno.test("a name with underscores keeps them", () => {
  // Underscores are emphasis only when punctuation or space bounds them; a
  // file name must not lose its separators to a markdown rule.
  assertEquals(
    markdownToText("my_file_name と _強調_ と snake_case"),
    "my_file_name と 強調 と snake_case",
  );
});

Deno.test("arithmetic is not emphasis", () => {
  assertEquals(markdownToText("3 * 4 * 5"), "3 * 4 * 5");
  assertEquals(markdownToText("glob は *.ts"), "glob は *.ts");
});

Deno.test("an escaped mark stays a character", () => {
  assertEquals(
    markdownToText("\\*これは斜体ではない\\*"),
    "*これは斜体ではない*",
  );
});

Deno.test("notificationText is one line of the words", () => {
  assertEquals(
    notificationText("## デプロイは緑\n\n問題はありません。", 120),
    "デプロイは緑 問題はありません。",
  );
  // The reply's own markdown list reads as a line of bullets.
  assertEquals(
    notificationText("- 在庫は 3 件\n- 返信待ちは 1 件", 120),
    "・在庫は 3 件 ・返信待ちは 1 件",
  );
});

Deno.test("notificationText leaves a card out", () => {
  // A card is presentation: a toast that showed its markup would be showing
  // the agent's source. The words around it still reach the reader.
  assertEquals(
    notificationText(
      '確認してください。\n\n```card\n<Card title="A"><Text>中身</Text></Card>\n```',
      120,
    ),
    "確認してください。",
  );
  // A reply that was only a card has no words to carry.
  assertEquals(
    notificationText("```card\n<Card><Text>中身</Text></Card>\n```", 120),
    "",
  );
});

Deno.test("notificationText cuts at the cap", () => {
  assertEquals(Array.from(notificationText("あ".repeat(500), 120)).length, 120);
  assertEquals(notificationText("短い", 120), "短い");
  assertEquals(notificationText(undefined, 120), "");
});
