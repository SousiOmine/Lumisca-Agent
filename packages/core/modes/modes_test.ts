import { assertEquals, assertNotEquals } from "@std/assert";
import { AGENT_MODES, findAgentMode } from "./mod.ts";
import { buildPlanPrompt, planMode } from "./plan.ts";
import {
  buildReviewPrompt,
  REVIEW_TARGET_LABELS,
  reviewMode,
} from "./review.ts";

Deno.test("AGENT_MODES: ids are unique and every mode has a label and options", () => {
  const ids = new Set<string>();
  for (const mode of AGENT_MODES) {
    assertEquals(ids.has(mode.id), false, `duplicate mode id: ${mode.id}`);
    ids.add(mode.id);
    assertEquals(mode.label.length > 0, true);
    assertEquals(mode.description.length > 0, true);
    const optionIds = new Set<string>();
    for (const option of mode.options) {
      assertEquals(
        optionIds.has(option.id),
        false,
        `duplicate option id in ${mode.id}: ${option.id}`,
      );
      optionIds.add(option.id);
      assertEquals(option.label.length > 0, true);
      assertEquals(option.description.length > 0, true);
    }
    // An option's prompt must actually be buildable.
    for (const option of mode.options) {
      assertEquals(mode.buildPrompt(option.id).length > 0, true);
    }
    // A text-taking mode has no fixed options: the request text is the
    // subject, so a menu level would have nothing to pick.
    if (mode.buildPromptForText !== undefined) {
      assertEquals(mode.options.length, 0);
    }
  }
});

Deno.test("findAgentMode finds registered modes and misses unknown ids", () => {
  assertEquals(findAgentMode("review"), reviewMode);
  assertEquals(findAgentMode("plan"), planMode);
  assertEquals(findAgentMode("nope"), undefined);
});

Deno.test("review mode: options cover both targets and build distinct prompts", () => {
  assertEquals(reviewMode.options.map((o) => o.id), [
    "base-diff",
    "uncommitted",
  ]);
  const base = reviewMode.buildPrompt("base-diff");
  const uncommitted = reviewMode.buildPrompt("uncommitted");
  assertNotEquals(base, uncommitted);
  assertEquals(
    reviewMode.buildPrompt("uncommitted"),
    buildReviewPrompt("uncommitted"),
  );
});

Deno.test("review prompt: reviewer role and no-modification rule", () => {
  const prompt = buildReviewPrompt("uncommitted");
  assertEquals(prompt.includes("コードレビュアー"), true);
  assertEquals(prompt.includes("別のエンジニアが行ったコード変更"), true);
  assertEquals(prompt.includes("コードの修正は行わない"), true);
  // Report-only: language is never specified.
  assertEquals(prompt.includes("日本語"), false);
});

Deno.test("review prompt: review rules are present", () => {
  const prompt = buildReviewPrompt("uncommitted");
  assertEquals(prompt.includes("正確性・性能・セキュリティ・保守性"), true);
  assertEquals(prompt.includes("具体的かつ修正可能"), true);
  assertEquals(prompt.includes("作者の意図について暗黙の仮定を置かない"), true);
  assertEquals(prompt.includes("実際に影響される箇所"), true);
  assertEquals(prompt.includes("意図的な変更"), true);
  assertEquals(prompt.includes("修正の方向性"), true);
});

Deno.test("review prompt: target-specific git steps", () => {
  const uncommitted = buildReviewPrompt("uncommitted");
  assertEquals(uncommitted.includes("未コミットの変更"), true);
  assertEquals(uncommitted.includes("git status"), true);
  assertEquals(uncommitted.includes("git diff HEAD"), true);
  assertEquals(uncommitted.includes("git diff <ベースブランチ>...HEAD"), false);

  const base = buildReviewPrompt("base-diff");
  assertEquals(base.includes("ベースブランチとの差分"), true);
  assertEquals(base.includes("git branch --show-current"), true);
  assertEquals(base.includes("git diff <ベースブランチ>...HEAD"), true);
  assertEquals(base.includes("git diff HEAD"), false);
});

Deno.test("REVIEW_TARGET_LABELS covers both targets", () => {
  assertEquals(REVIEW_TARGET_LABELS["base-diff"], "ベースブランチとの差分");
  assertEquals(REVIEW_TARGET_LABELS.uncommitted, "未コミットの変更");
});

Deno.test("plan mode: takes the request text and has no options", () => {
  assertEquals(planMode.options.length, 0);
  assertEquals(planMode.buildPromptForText !== undefined, true);
  assertEquals(planMode.modeLabel, "プランモード");
});

Deno.test("plan prompt: embeds the request and the internal rules", () => {
  const prompt = planMode.buildPromptForText!("ブラウザ履歴機能を追加したい");
  assertEquals(prompt.includes("ブラウザ履歴機能を追加したい"), true);
  assertEquals(prompt.includes("実装計画を立案"), true);
  // No edits until the user explicitly permits them.
  assertEquals(prompt.includes("明示的に許可するまで"), true);
  assertEquals(prompt.includes("編集・書き込みは禁止"), true);
  assertEquals(prompt.includes("write / edit ツールは使用せず"), true);
  // Undecidable questions go to the ask tool.
  assertEquals(prompt.includes("ask ツールでユーザーに質問"), true);
  // Permission is asked at the end, and implementation follows only on
  // explicit approval.
  assertEquals(prompt.includes("実装を進めますか"), true);
  assertEquals(prompt.includes("明示的に実装を許可した場合のみ"), true);
  assertEquals(prompt.includes("計画に沿って実装を開始"), true);
});

Deno.test("plan mode: empty fallback prompt asks for the request instead of planning blindly", () => {
  const prompt = buildPlanPrompt("");
  assertEquals(prompt.length > 0, true);
  assertEquals(prompt.includes("依頼内容が指定されていません"), true);
  assertEquals(prompt.includes("明示的に許可するまで"), true);
  assertEquals(buildPlanPrompt("  "), buildPlanPrompt(""));
});
