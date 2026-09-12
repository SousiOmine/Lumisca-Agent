import { assertEquals } from "@std/assert";
import { detectSlash } from "./hooks/useSlashMenu.ts";
import {
  modeRewindText,
  slashCommands,
  slashPrompt,
  slashPromptFromText,
} from "./slashCommands.ts";

const planCommand = slashCommands.find((c) => c.id === "plan");
const reviewCommand = slashCommands.find((c) => c.id === "review");
const goalCommand = slashCommands.find((c) => c.id === "goal");

Deno.test("slashCommands: plan and goal are text-taking (complete) commands", () => {
  assertEquals(planCommand !== undefined, true);
  assertEquals(planCommand!.kind, "complete");
  assertEquals(planCommand!.items, undefined);
  // Review is a mode palette: it runs only from the start of the input.
  assertEquals(reviewCommand !== undefined, true);
  assertEquals(reviewCommand!.kind, "run");
  assertEquals(goalCommand !== undefined, true);
  assertEquals(goalCommand!.kind, "complete");
});

Deno.test("slashPrompt: text-taking mode wraps the trailing text", () => {
  const result = slashPrompt(planCommand!, undefined, "  履歴機能を追加して ");
  assertEquals(result !== null, true);
  assertEquals(result!.mode.modeId, "plan");
  assertEquals(result!.mode.optionId, "");
  assertEquals(result!.mode.modeLabel, "プラン作成モード");
  assertEquals(result!.mode.shortText, "履歴機能を追加して");
  assertEquals(result!.text.includes("履歴機能を追加して"), true);
  assertEquals(result!.text.includes("実装計画を立案"), true);
});

Deno.test("slashPrompt: text-taking mode without text builds nothing", () => {
  assertEquals(slashPrompt(planCommand!, undefined), null);
  assertEquals(slashPrompt(planCommand!, undefined, ""), null);
  assertEquals(slashPrompt(planCommand!, undefined, "   "), null);
});

Deno.test("slashPromptFromText: /plan <request> wraps as a text line", () => {
  const line = slashPromptFromText("/plan 履歴機能を追加して");
  if (line === null || line.kind !== "wrap") return;
  assertEquals(line.mode.modeId, "plan");
  assertEquals(line.mode.shortText, "履歴機能を追加して");
  assertEquals(line.text.includes("履歴機能を追加して"), true);
});

Deno.test("slashPromptFromText: bare command token needs the request", () => {
  // The token without a request resolves to "needs-text" (nothing sent).
  assertEquals(slashPromptFromText("/plan")?.kind, "needs-text");
  assertEquals(slashPromptFromText("/plan ")?.kind, "needs-text");
  assertEquals(slashPromptFromText("/plan\n")?.kind, "needs-text");
  // Leading whitespace is trimmed like the composer does before wrapping.
  assertEquals(slashPromptFromText("  /plan なにか")?.kind, "wrap");
  assertEquals(slashPromptFromText(" /plan")?.kind, "needs-text");
});

Deno.test("slashPromptFromText: plain text and non-text commands pass through", () => {
  assertEquals(slashPromptFromText("普通のメッセージ"), null);
  assertEquals(slashPromptFromText("レビューして"), null);
  // review takes no text: the line is not a text-taking command.
  assertEquals(slashPromptFromText("/review 差分を"), null);
  // Unknown commands pass through too.
  assertEquals(slashPromptFromText("/nope なにか"), null);
});

Deno.test("slashPromptFromText: mid-text /plan wraps and keeps both sides", () => {
  // The command can sit anywhere a word starts; the text the user wrote
  // around it becomes the request (token removed, sides joined by a space).
  const line = slashPromptFromText("背景メモ /plan 履歴を追加して");
  if (line === null || line.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(line.mode.modeId, "plan");
  assertEquals(line.mode.shortText, "背景メモ 履歴を追加して");
  assertEquals(line.text.includes("背景メモ 履歴を追加して"), true);

  // The first text-taking command wins; its query is not part of the
  // request.
  const multi = slashPromptFromText("メモ /plan 一つ目 /plan 二つ目");
  if (multi === null || multi.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(multi.mode.shortText, "メモ 一つ目 /plan 二つ目");

  // A command after the caret-agnostic token: the exact position does not
  // matter, only the word-start boundary.
  const mid = slashPromptFromText("まず /plan を実行して、それから /goal 続行");
  if (mid === null || mid.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(mid.mode.modeId, "plan");
  assertEquals(mid.mode.shortText, "まず を実行して、それから /goal 続行");
});

Deno.test("slashPromptFromText: mid-text token keeps the other side as request", () => {
  // The request is the text the user wrote around the token — both sides
  // trimmed and joined. A completed token at the end of a memo keeps the
  // memo as the request (メモ /plan → 「メモ」); the menu only ever
  // transforms the input, it never sends.
  const head = slashPromptFromText("メモ /plan");
  if (head === null || head.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(head.mode.shortText, "メモ");
  const headSpace = slashPromptFromText("メモ /plan ");
  if (headSpace === null || headSpace.kind !== "wrap") {
    throw new Error("expected wrap");
  }
  assertEquals(headSpace.mode.shortText, "メモ");
  // An empty command at the input start still sends nothing.
  assertEquals(slashPromptFromText("/plan")?.kind, "needs-text");
  assertEquals(slashPromptFromText("/plan ")?.kind, "needs-text");
  // Both sides are joined.
  assertEquals(
    slashPromptFromText("メモ /plan 履歴")?.kind,
    "wrap",
  );
});

Deno.test("slashPromptFromText: word-start boundary (no slash inside words)", () => {
  // A slash glued to a word is not a command (paths, URLs, prose).
  assertEquals(slashPromptFromText("src/plan なにか"), null);
  assertEquals(slashPromptFromText("https://example.com/plan"), null);
  assertEquals(slashPromptFromText("あれ/plan して"), null);
  // After punctuation the slash is literal prose.
  assertEquals(slashPromptFromText("（/plan なにか）"), null);
});

Deno.test("modeRewindText: text-taking modes restore as a command line", () => {
  // Plan mode: rewinding restores `/plan <依頼文>`, so a re-send
  // re-enters the mode instead of degrading to a plain message.
  assertEquals(
    modeRewindText("plan", "履歴機能を追加して"),
    "/plan 履歴機能を追加して",
  );
  // Goal mode behaves the same: `/goal <ゴール文>`.
  assertEquals(
    modeRewindText("goal", "全テストが通るまで実装して"),
    "/goal 全テストが通るまで実装して",
  );
  // Menu modes keep their self-contained short text.
  assertEquals(
    modeRewindText("review", "未コミットの変更をレビューしてください"),
    "未コミットの変更をレビューしてください",
  );
  // Unknown mode ids degrade to the short text.
  assertEquals(modeRewindText("nope", "なにか"), "なにか");
});

Deno.test("slashPrompt: goal mode wraps the trailing text", () => {
  const result = slashPrompt(
    goalCommand!,
    undefined,
    "  全テストが通るまで実装して ",
  );
  assertEquals(result !== null, true);
  assertEquals(result!.mode.modeId, "goal");
  assertEquals(result!.mode.optionId, "");
  assertEquals(result!.mode.modeLabel, "ゴールモード");
  assertEquals(result!.mode.shortText, "全テストが通るまで実装して");
  assertEquals(result!.text.includes("全テストが通るまで実装して"), true);
  assertEquals(result!.text.includes("ゴール達成エージェント"), true);
});

Deno.test("slashPromptFromText: /goal <goal> wraps as a text line", () => {
  const line = slashPromptFromText("/goal 全テストが通るまで実装して");
  if (line === null || line.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(line.mode.modeId, "goal");
  assertEquals(line.mode.shortText, "全テストが通るまで実装して");
  assertEquals(line.text.includes("全テストが通るまで実装して"), true);
});

// --- detectSlash: where the menu opens --------------------------------

Deno.test("detectSlash: captures the token under the caret", () => {
  // Caret at the end of `/`: query empty, token covers [0, 1).
  assertEquals(detectSlash("/", 1, false), {
    start: 0,
    end: 1,
    query: "",
    rest: "",
  });
  // Caret inside the name.
  assertEquals(detectSlash("/plan", 4, false), {
    start: 0,
    end: 5,
    query: "pla",
    rest: "",
  });
  // Caret right after the full name.
  assertEquals(detectSlash("/plan", 5, false), {
    start: 0,
    end: 5,
    query: "plan",
    rest: "",
  });
});

Deno.test("detectSlash: word-start only (no slash inside words)", () => {
  assertEquals(detectSlash("src/plan", 8, false), null);
  assertEquals(detectSlash("あれ/plan", 8, false), null);
  assertEquals(detectSlash("https://example.com/plan", 24, false), null);
  // Whitespace before the slash is fine (space, newline, full-width
  // space); punctuation is not.
  assertEquals(detectSlash("メモ /plan", 8, false)?.start, 3);
  assertEquals(detectSlash("一行目\n/plan", 9, false)?.start, 4);
  assertEquals(detectSlash("メモ\u3000/plan", 8, false)?.start, 3);
  assertEquals(detectSlash("メモ、/plan", 8, false), null);
  assertEquals(detectSlash("（/plan", 6, false), null);
});

Deno.test("detectSlash: caret must stay in the token (closes after space)", () => {
  // Space after the command → no menu (typing prose after a completed
  // command keeps it prose).
  assertEquals(detectSlash("/plan ", 6, false), null);
  assertEquals(detectSlash("/plan なにか", 6, false), null);
  // ...unless a submenu is open: the text between the token and the caret
  // is that submenu's filter.
  assertEquals(detectSlash("/plan なにか", 9, true)?.rest, " なにか");
});

Deno.test("detectSlash: the nearest token behind the caret wins", () => {
  assertEquals(detectSlash("メモ /plan あと /re", 18, false)?.query, "re");
  assertEquals(detectSlash("メモ /plan あと /re", 18, false)?.start, 12);
});
