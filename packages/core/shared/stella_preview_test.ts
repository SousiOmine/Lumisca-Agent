import { assertEquals } from "@std/assert";
import type { StellaEntry } from "../domain/stella-conversation.ts";
import {
  compareAgentRows,
  PREVIEW_TEXT_CHARS,
  previewOf,
  previewText,
  type StellaAgentSummary,
  type StellaPreview,
  samePreview,
  withAgentRow,
} from "./mod.ts";

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
    segments: [],
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
  const attachments = [
    {
      name: "x.png",
      displayName: "x.png",
      size: 1,
      inline: true,
    },
  ];
  assertEquals(previewOf(entry({ attachments })), {
    kind: "files",
    count: 1,
    at: 1_000,
  });
  // A card alone names its kind (`card` wins over nothing).
  assertEquals(
    previewOf(
      entry({
        segments: [{ type: "card", markup: "<Card />" }],
      }),
    ),
    {
      kind: "card",
      at: 1_000,
    },
  );
  // Nothing at all: nothing to say.
  assertEquals(previewOf(entry()), null);
});

Deno.test("previewOf: words win over a card and files", () => {
  // The message read as a sentence, not as "1 file": the words are what the
  // reader scans for.
  assertEquals(
    previewOf(
      entry({
        text: "確認してください。",
        segments: [
          { type: "text", text: "確認してください。" },
          { type: "card", markup: "<Card />" },
        ],
        files: [
          {
            name: "a.png",
            path: "/a.png",
            size: 1,
            ref: "r1",
            image: true,
          },
        ],
      }),
    ),
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
  assertEquals(
    rows.sort(compareAgentRows).map((r) => r.id),
    ["new", "mid", "old"],
  );
});

Deno.test("compareAgentRows: conversations with nothing said come last", () => {
  // They have no time to show, so they must not interleave with rows that
  // do — among themselves they stay in the agent's own last-used order.
  const rows = [
    row("quiet-old", null, { updatedAt: 10 }),
    row("said", 100),
    row("quiet-new", null, { updatedAt: 20 }),
  ];
  assertEquals(
    rows.sort(compareAgentRows).map((r) => r.id),
    ["said", "quiet-new", "quiet-old"],
  );
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

Deno.test("previewOf: a routine's prompt is not a message of the row", () => {
  // The conversation does not draw a routine's prompt (it is the
  // instruction the agent wrote), so the row must not speak for it either:
  // the caller reads the next older entry.
  assertEquals(
    previewOf(
      entry({
        role: "user",
        text: "毎朝デプロイを確認して",
        routine: "朝のデプロイ確認",
      }),
    ),
    null,
  );
  // A typed prompt of the same words is still the user's message.
  assertEquals(
    previewOf(entry({ role: "user", text: "毎朝デプロイを確認して" })),
    {
      kind: "text",
      text: "毎朝デプロイを確認して",
      at: 1_000,
    },
  );
});

Deno.test("withAgentRow: a created agent is in the list before it is opened", () => {
  // Regression: creating an agent selected it before the list had read it,
  // and an address naming an agent the list does not hold is treated as a
  // conversation that is gone (the App sends it back to the list). The
  // create's answer carries the row, so it goes in from there.
  const rows = [row("said", 100), row("quiet", null)];
  const created = withAgentRow(rows, {
    id: "fresh",
    name: "Aide",
    icon: "",
    model: null,
    createdAt: 300,
    updatedAt: 300,
  });
  assertEquals(
    created.map((r) => r.id),
    ["said", "fresh", "quiet"],
  );
  // A new agent has said nothing, so its row is one line.
  assertEquals(created.find((r) => r.id === "fresh")?.preview, null);
  // The list it came from is left alone (the hook keeps the old one until
  // the state lands).
  assertEquals(rows.length, 2);
});

Deno.test("withAgentRow: an edit keeps the row's line and does not double it", () => {
  const rows = [row("a1", 100), row("b2", null)];
  const edited = withAgentRow(rows, {
    id: "a1",
    name: "Renamed",
    icon: "",
    model: null,
    createdAt: 0,
    updatedAt: 0,
  });
  assertEquals(edited.length, 2);
  const row1 = edited.find((r) => r.id === "a1")!;
  assertEquals(row1.name, "Renamed");
  // What the conversation said is not what the edit changed.
  assertEquals(row1.preview, { kind: "text", text: "a1", at: 100 });
});
