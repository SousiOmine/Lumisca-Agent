import { assertEquals, assertNotEquals } from "@std/assert";
import { AGENT_MODES, findAgentMode } from "./mod.ts";
import { buildGoalPrompt, goalMode } from "./goal.ts";
import { buildPlanPrompt, planMode } from "./plan.ts";
import { buildReviewPrompt, reviewMode } from "./review.ts";
import { messages } from "../shared/mod.ts";

/** Any Japanese character: the prompts are uniformly English (the answer's
 * language is the session's, see tools/language.ts), so an accidental
 * translation of the instructions is a regression. */
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;

Deno.test("AGENT_MODES: ids are unique and every mode has menu text and options", () => {
  const ids = new Set<string>();
  for (const mode of AGENT_MODES) {
    assertEquals(ids.has(mode.id), false, `duplicate mode id: ${mode.id}`);
    ids.add(mode.id);
    // The menu text lives in the catalogue: every key must exist, in both
    // languages (a missing one would render as the raw key).
    for (const key of [mode.label, mode.description, mode.modeLabel]) {
      const text = messages[key];
      assertEquals(text !== undefined, true, `missing catalogue key: ${key}`);
      assertEquals(text.ja.length > 0, true, `empty ja text: ${key}`);
      assertEquals(text.en.length > 0, true, `empty en text: ${key}`);
    }
    const optionIds = new Set<string>();
    for (const option of mode.options) {
      assertEquals(
        optionIds.has(option.id),
        false,
        `duplicate option id in ${mode.id}: ${option.id}`,
      );
      optionIds.add(option.id);
      for (const key of [option.label, option.description, option.shortText]) {
        const text = messages[key];
        assertEquals(text !== undefined, true, `missing catalogue key: ${key}`);
        assertEquals(text.ja.length > 0, true, `empty ja text: ${key}`);
        assertEquals(text.en.length > 0, true, `empty en text: ${key}`);
      }
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
  assertEquals(findAgentMode("goal"), goalMode);
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

Deno.test("review prompt: reviewer role and report-only rule", () => {
  const prompt = buildReviewPrompt("uncommitted");
  assertEquals(prompt.includes("code reviewer"), true);
  assertEquals(prompt.includes("another engineer"), true);
  assertEquals(prompt.includes("Do not fix the code"), true);
  assertEquals(JAPANESE.test(prompt), false);
});

Deno.test("review prompt: review rules are present", () => {
  const prompt = buildReviewPrompt("uncommitted");
  assertEquals(prompt.includes("correctness, performance, security"), true);
  assertEquals(prompt.includes("concrete and fixable"), true);
  assertEquals(prompt.includes("assumptions about the author's intent"), true);
  assertEquals(prompt.includes("places actually affected"), true);
  assertEquals(prompt.includes("intentional changes"), true);
  assertEquals(prompt.includes("Suggested direction"), true);
});

Deno.test("review prompt: target-specific git steps", () => {
  const uncommitted = buildReviewPrompt("uncommitted");
  assertEquals(uncommitted.includes("uncommitted changes"), true);
  assertEquals(uncommitted.includes("git status"), true);
  assertEquals(uncommitted.includes("git diff HEAD"), true);
  assertEquals(uncommitted.includes("git diff <base branch>...HEAD"), false);

  const base = buildReviewPrompt("base-diff");
  assertEquals(base.includes("diff against the base branch"), true);
  assertEquals(base.includes("git branch --show-current"), true);
  assertEquals(base.includes("git diff <base branch>...HEAD"), true);
  assertEquals(base.includes("git diff HEAD"), false);
});

Deno.test("plan mode: takes the request text and has no options", () => {
  assertEquals(planMode.options.length, 0);
  assertEquals(planMode.buildPromptForText !== undefined, true);
  assertEquals(planMode.modeLabel, "chat.mode.plan.modeLabel");
});

Deno.test("plan prompt: embeds the request and the internal rules", () => {
  const prompt = planMode.buildPromptForText!("add a browsing history");
  assertEquals(prompt.includes("add a browsing history"), true);
  assertEquals(prompt.includes("implementation planner"), true);
  // No edits until the user explicitly permits them.
  assertEquals(prompt.includes("explicitly permits"), true);
  assertEquals(prompt.includes("Do not edit or write files"), true);
  assertEquals(prompt.includes("write / edit tools"), true);
  // Undecidable questions go to the ask tool.
  assertEquals(prompt.includes("ask tool"), true);
  // Permission is asked at the end, and implementation follows only on
  // explicit approval.
  assertEquals(prompt.includes("whether to run it"), true);
  assertEquals(prompt.includes("stop after the plan"), true);
  assertEquals(prompt.includes("follow the plan faithfully"), true);
  assertEquals(JAPANESE.test(prompt), false);
});

Deno.test("plan mode: empty fallback prompt asks for the request instead of planning blindly", () => {
  const prompt = buildPlanPrompt("");
  assertEquals(prompt.length > 0, true);
  assertEquals(prompt.includes("No request was given"), true);
  assertEquals(prompt.includes("explicitly permits"), true);
  assertEquals(buildPlanPrompt("  "), buildPlanPrompt(""));
});

Deno.test("goal mode: takes the goal text and has no options", () => {
  assertEquals(goalMode.options.length, 0);
  assertEquals(goalMode.buildPromptForText !== undefined, true);
  assertEquals(goalMode.modeLabel, "chat.mode.goal.modeLabel");
});

Deno.test("goal prompt: embeds the goal and the working rules", () => {
  const prompt = goalMode.buildPromptForText!("implement until all tests pass");
  assertEquals(prompt.includes("implement until all tests pass"), true);
  assertEquals(prompt.includes("goal-achieving agent"), true);
  assertEquals(prompt.includes("report completion"), true);
  // Undecidable questions go to the ask tool.
  assertEquals(prompt.includes("ask tool"), true);
  assertEquals(JAPANESE.test(prompt), false);
});

Deno.test("goal mode: empty fallback prompt asks for the goal instead of running blindly", () => {
  const prompt = buildGoalPrompt("");
  assertEquals(prompt.length > 0, true);
  assertEquals(prompt.includes("No goal was given"), true);
  assertEquals(prompt.includes("goal-achieving agent"), true);
  assertEquals(buildGoalPrompt("  "), buildGoalPrompt(""));
});
