import { assertEquals } from "@std/assert";
import { buildSkillPrompt } from "./slash.ts";

Deno.test("buildSkillPrompt: names the skill and the tool that loads it", () => {
  const prompt = buildSkillPrompt("canvas-design", "");
  assertEquals(
    prompt,
    "スキル「canvas-design」を呼び出してください。skill ツールで" +
      "「canvas-design」を読み込み、その指示に従ってください。",
  );
});

Deno.test("buildSkillPrompt: a request becomes the 依頼内容 section", () => {
  const prompt = buildSkillPrompt("canvas-design", "  ポスターを作って  ");
  // The request is trimmed and appended as its own section, so the agent
  // reads the skill's instructions first and then the work to do.
  assertEquals(prompt.endsWith("\n\n# 依頼内容\nポスターを作って"), true);
  assertEquals(prompt.startsWith("スキル「canvas-design」を呼び出して"), true);
  // Whitespace-only requests are no request at all.
  assertEquals(buildSkillPrompt("x", "  \n "), buildSkillPrompt("x", ""));
});
