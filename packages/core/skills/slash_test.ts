import { assertEquals } from "@std/assert";
import { buildSkillPrompt } from "./slash.ts";

/** The slash command's prompt is a fixed English frame around an optional
 * request. What it has to get right: the frame names the skill and the tool
 * that loads it, a request becomes its own trailing section, and the text
 * stays English whatever the request's language is (the answer's language is
 * the session's, see tools/language.ts). */

Deno.test("buildSkillPrompt frames the skill and appends the request", () => {
  assertEquals(
    buildSkillPrompt("canvas-design", ""),
    'Invoke the skill "canvas-design": load it with the skill tool and ' +
      "follow the instructions it provides.",
  );

  // The request is trimmed and appended as its own section, so the agent
  // reads the skill's instructions first and then the work to do.
  const prompt = buildSkillPrompt("canvas-design", "  make a poster  ");
  assertEquals(prompt.endsWith("\n\n# Request\nmake a poster"), true);
  assertEquals(prompt.startsWith('Invoke the skill "canvas-design"'), true);
  // Whitespace-only requests are no request at all.
  assertEquals(buildSkillPrompt("x", "  \n "), buildSkillPrompt("x", ""));

  // A Japanese request must not turn the frame Japanese: the app's prompts
  // are uniformly English.
  assertEquals(
    buildSkillPrompt("canvas-design", "ポスターを作って").includes(
      "してください",
    ),
    false,
  );
});
