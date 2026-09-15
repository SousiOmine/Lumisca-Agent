import { assertEquals } from "@std/assert";
import { buildSkillPrompt } from "./slash.ts";

Deno.test("buildSkillPrompt: names the skill and the tool that loads it", () => {
  const prompt = buildSkillPrompt("canvas-design", "");
  assertEquals(
    prompt,
    'Invoke the skill "canvas-design": load it with the skill tool and ' +
      "follow the instructions it provides.",
  );
});

Deno.test("buildSkillPrompt: a request becomes the Request section", () => {
  const prompt = buildSkillPrompt("canvas-design", "  make a poster  ");
  // The request is trimmed and appended as its own section, so the agent
  // reads the skill's instructions first and then the work to do.
  assertEquals(prompt.endsWith("\n\n# Request\nmake a poster"), true);
  assertEquals(prompt.startsWith('Invoke the skill "canvas-design"'), true);
  // Whitespace-only requests are no request at all.
  assertEquals(buildSkillPrompt("x", "  \n "), buildSkillPrompt("x", ""));
});

Deno.test("buildSkillPrompt: the prompt is English whatever the request is", () => {
  // The app's prompts are uniformly English; the answer's language is the
  // session's (see tools/language.ts), so a Japanese request must not turn
  // the instructions Japanese.
  const prompt = buildSkillPrompt("canvas-design", "ポスターを作って");
  assertEquals(prompt.includes("Invoke the skill"), true);
  assertEquals(prompt.includes("してください"), false);
});
