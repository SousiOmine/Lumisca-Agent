import { assertEquals, assertNotEquals } from "@std/assert";
import { AGENT_MODES, findAgentMode } from "./mod.ts";
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
  }
});

Deno.test("findAgentMode finds registered modes and misses unknown ids", () => {
  assertEquals(findAgentMode("review"), reviewMode);
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
