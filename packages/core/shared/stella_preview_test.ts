import { assertEquals } from "@std/assert";
import {
  compareAgentRows,
  PREVIEW_TEXT_CHARS,
  previewOf,
  previewText,
  samePreview,
  type StellaAgentSummary,
  type StellaPreview,
} from "./mod.ts";
import type { StellaEntry } from "../types/stella-conversation.ts";

/**
 * The second line of an agent's sidebar row.
 *
 * Two things matter: the line is what the conversation SHOWS (so a message
 * that was only a card must not become an empty row, and markup must not
 * become the beginning of half the rows), and the order matches the time the
 * row shows (so a list that mentions when something was said is not ordered
 * by something else).
 */

/** One conversation entry with the fields a preview reads. */
function entry(overrides: Partial<StellaEntry> = {}): StellaEntry {
  return {
    role: "assistant",
    text: "",
    card: null,
    attachments: [],
    files: [],
    timestamp: 1_000,
    ...overrides,
  };
}

Deno.test("previewText: block markers are not words", () => {
  assertEquals(previewText("## 見出し"), "見出し");
  assertEquals(previewText("- 項目"), "項目");
  assertEquals(previewText("* 項目"), "項目");
  assertEquals(previewText("+ 項目"), "項目");
  assertEquals(previewText("> 引用"), "引用");
  assertEquals(previewText("1. 手順"), "手順");
  assertEquals(previewText("2) 手順"), "手順");
  // A rule is a whole line of markers with no words in it.
  assertEquals(previewText("---"), "");
});

Deno.test("previewText: a message becomes one line", () => {
  assertEquals(previewText("一行目\n二行目"), "一行目 二行目");
  assertEquals(previewText("  余白  \n\n  だらけ  "), "余白 だらけ");
  // A fence's line is markup; the code inside it is what the bubble shows.
  assertEquals(previewText("```ts\nconst x = 1;\n```"), "const x = 1;");
});

Deno.test("previewText: emphasis and links keep their words", () => {
  assertEquals(previewText("**重要**です"), "重要です");
  assertEquals(previewText("__重要__です"), "重要です");
  assertEquals(previewText("`npm test` を実行"), "npm test を実行");
  assertEquals(
    previewText("[ドキュメント](https://example.com/a)を見る"),
    "ドキュメントを見る",
  );
  assertEquals(
    previewText("![グラフ](https://example.com/a.png) を送ります"),
    "グラフ を送ります",
  );
  // A table's pipes are syntax, not the sentence.
  assertEquals(previewText("| 項目 | 値 |"), "項目 値");
});

Deno.test("previewText: a marker inside a word is not emphasis", () => {
  // Removing these would change what the message said.
  assertEquals(previewText("snake_case の名前"), "snake_case の名前");
  assertEquals(previewText("2*3 は 6"), "2*3 は 6");
});

Deno.test("previewText: a long message is cut and says so", () => {
  const long = "あ".repeat(PREVIEW_TEXT_CHARS + 50);
  const text = previewText(long);
  assertEquals([...text].length, PREVIEW_TEXT_CHARS + 1);
  assertEquals(text.endsWith("…"), true);
  // Exactly at the bound is left alone (no ellipsis for a message that fits).
  assertEquals(
    previewText("あ".repeat(PREVIEW_TEXT_CHARS)).endsWith("…"),
    false,
  );
});

Deno.test("previewText: a cut never splits a character", () => {
  // An emoji is two UTF-16 units; cutting between them would leave a lone
  // surrogate, which renders as a replacement box.
  const text = previewText("🤖".repeat(PREVIEW_TEXT_CHARS));
  assertEquals(text.endsWith("…"), true);
  assertEquals(text.isWellFormed(), true);
});

Deno.test("previewOf: words are the message", () => {
  assertEquals(previewOf(entry({ text: "直しました。" })), {
    kind: "text",
    text: "直しました。",
    at: 1_000,
  });
});

Deno.test("previewOf: a message with no words is described", () => {
  const files = [
    { name: "a.png", path: "/a.png", size: 1, ref: "r1", image: true },
    { name: "b.txt", path: "/b.txt", size: 2, ref: "r2", image: false },
  ];
  // A prompt that was an image alone is still a turn: the row says how many.
  assertEquals(previewOf(entry({ files })), {
    kind: "files",
    count: 2,
    at: 1_000,
  });
  // What the agent sent.
  const attachments = [{
    name: "x.png",
    displayName: "x.png",
    size: 1,
    inline: true,
  }];
  assertEquals(previewOf(entry({ attachments })), {
    kind: "files",
    count: 1,
    at: 1_000,
  });
  // A card alone names its kind (`card` wins over nothing).
  assertEquals(previewOf(entry({ card: "<Card />" })), {
    kind: "card",
    at: 1_000,
  });
  // Nothing at all: nothing to say.
  assertEquals(previewOf(entry()), null);
});

Deno.test("previewOf: words win over a card and files", () => {
  // The message read as a sentence, not as "1 file": the words are what the
  // reader scans for.
  assertEquals(
    previewOf(entry({
      text: "確認してください。",
      card: "<Card />",
      files: [{
        name: "a.png",
        path: "/a.png",
        size: 1,
        ref: "r1",
        image: true,
      }],
    })),
    { kind: "text", text: "確認してください。", at: 1_000 },
  );
});

Deno.test("samePreview: the same line is the same preview", () => {
  const text: StellaPreview = { kind: "text", text: "a", at: 1 };
  assertEquals(samePreview(text, { kind: "text", text: "a", at: 1 }), true);
  assertEquals(samePreview(text, { kind: "text", text: "a", at: 2 }), false);
  assertEquals(samePreview(text, { kind: "text", text: "b", at: 1 }), false);
  assertEquals(samePreview(text, { kind: "card", at: 1 }), false);
  assertEquals(samePreview(text, null), false);
  assertEquals(samePreview(null, null), true);
});

/** One agent row with a preview at `at` (null = no preview). */
function row(
  id: string,
  at: number | null,
  extra: Partial<StellaAgentSummary> = {},
): StellaAgentSummary {
  return {
    id,
    name: id,
    icon: "",
    model: null,
    createdAt: 0,
    updatedAt: 0,
    preview: at === null ? null : { kind: "text", text: id, at },
    ...extra,
  };
}

Deno.test("compareAgentRows: the list is ordered by the time it shows", () => {
  const rows = [row("old", 100), row("new", 300), row("mid", 200)];
  assertEquals(rows.sort(compareAgentRows).map((r) => r.id), [
    "new",
    "mid",
    "old",
  ]);
});

Deno.test("compareAgentRows: conversations with nothing said come last", () => {
  // They have no time to show, so they must not interleave with rows that
  // do — among themselves they stay in the agent's own last-used order.
  const rows = [
    row("quiet-old", null, { updatedAt: 10 }),
    row("said", 100),
    row("quiet-new", null, { updatedAt: 20 }),
  ];
  assertEquals(rows.sort(compareAgentRows).map((r) => r.id), [
    "said",
    "quiet-new",
    "quiet-old",
  ]);
});

Deno.test("compareAgentRows: the order is total", () => {
  // The list re-reads on a timer, so two rows that compare equal would swap
  // places between refreshes.
  const a = row("a", 100, { createdAt: 5 });
  const b = row("b", 100, { createdAt: 5 });
  assertEquals(compareAgentRows(a, b) < 0, true);
  assertEquals(compareAgentRows(b, a) > 0, true);
  assertEquals(compareAgentRows(a, a), 0);
  // Ties fall back to creation time before the id.
  const older = row("z", 100, { createdAt: 1 });
  const newer = row("a", 100, { createdAt: 2 });
  assertEquals(compareAgentRows(newer, older) < 0, true);
});

Deno.test("previewOf: a routine's prompt is named, not quoted as the user's", () => {
  const preview = previewOf(
    entry({
      role: "user",
      text: "毎朝デプロイを確認して",
      routine: "朝のデプロイ確認",
    }),
  );
  assertEquals(preview, {
    kind: "routine",
    name: "朝のデプロイ確認",
    at: 1_000,
  });
  // The name is what the row shows, so two routines differ.
  assertEquals(
    samePreview(preview, {
      kind: "routine",
      name: "朝のデプロイ確認",
      at: 1_000,
    }),
    true,
  );
  assertEquals(
    samePreview(preview, { kind: "routine", name: "別のルーチン", at: 1_000 }),
    false,
  );
  // A typed prompt of the same words still reads as words.
  assertEquals(
    previewOf(entry({ role: "user", text: "毎朝デプロイを確認して" })),
    {
      kind: "text",
      text: "毎朝デプロイを確認して",
      at: 1_000,
    },
  );
});
