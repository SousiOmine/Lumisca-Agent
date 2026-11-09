import { assert, assertEquals } from "@std/assert";
import { DEFAULT_LOCALE } from "../shared/mod.ts";
import { TOOL_READ, TOOL_TODO } from "../shared/tool-names.ts";
import { outputLanguageBullet, outputLanguageSentence } from "./language.ts";
import { buildChatSystemPrompt, buildSystemPrompt } from "./system-prompt.ts";
import { subagentSystemPrompt } from "./subagent-format.ts";
import type { Workspace } from "../domain/workspace.ts";

/** A folder-less workspace for prompt tests. */
const workspace: Workspace = {
  id: "ws_test",
  name: "test",
  folders: [],
  createdAt: 0,
  chat: false,
};

/** A couple of tools, so the guidelines render more than the language
 * rule (the sections key on the preloaded tool set). */
const TOOLS = [TOOL_READ, TOOL_TODO];

Deno.test("outputLanguageBullet: names the language, in English, for both", () => {
  const ja = outputLanguageBullet("ja");
  assertEquals(ja.includes("Japanese"), true);
  const en = outputLanguageBullet("en");
  assertEquals(en.includes("English"), true);
  // The prompt text itself is uniformly English: only the language the
  // agent must answer in varies.
  const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/;
  assertEquals(japanese.test(ja), false);
  assertEquals(japanese.test(en), false);
  // The session's language is fixed at session start — the rule has to say
  // so, otherwise the agent mirrors the user's message language.
  assertEquals(ja.includes("session started"), true);
  assertEquals(ja.includes("do not switch"), true);
});

Deno.test("the system prompt carries no guidelines at all", () => {
  // Both kinds are gone: the per-tool guidance duplicated what each tool's
  // description already says, and the output-language rule is published as a
  // context message now (agent/language-context.ts), because it is a setting
  // that can change while the session lives.
  const prompt = buildSystemPrompt(workspace);
  assertEquals(prompt.split("\n").filter((line) => line.startsWith("- ")), []);
  assertEquals(prompt.includes("- Prioritize correctness."), false);
  assertEquals(prompt.includes("Write every reply in"), false);
});

Deno.test("buildSystemPrompt: nothing that varies with the session is in it", () => {
  // The prompt is re-derived on every open and compared against the stored
  // value (see AgentFactory.ensureSystemPrompt), so it may only carry what
  // describes where the session works. The language is a setting and the
  // tool set changes with the extras: both travel as context messages.
  const prompt = buildSystemPrompt(workspace);
  assertEquals(prompt.includes("Write every reply in"), false);
  // No tool name either — the prompt would go stale the moment a backend
  // detached or a server was added.
  for (const name of TOOLS) {
    assertEquals(prompt.includes(name), false, `${name} must not be named`);
  }
});

Deno.test("buildChatSystemPrompt: no rule and no tool name in the prompt either", () => {
  const prompt = buildChatSystemPrompt();
  assertEquals(prompt.includes("Write every reply in"), false);
  assertEquals(prompt.includes("available_skills"), false);
});

Deno.test("subagentSystemPrompt: reports come back in the session language", () => {
  const explore = subagentSystemPrompt(
    "agent_2",
    "agent_1",
    "explore",
    [],
    "ja",
  );
  assertEquals(explore.includes("Write every reply in Japanese"), true);
  const general = subagentSystemPrompt(
    "agent_3",
    "agent_1",
    "general",
    [],
    "en",
  );
  assertEquals(general.includes("Write every reply in English"), true);
  // The identity header is untouched.
  assert(general.includes("You are a coding sub-agent of Lumisca"));
  // Omitted → the fallback language (sub-agents of a session built before
  // the language existed still get a rule).
  const fallback = subagentSystemPrompt("a", "b", "explore", []);
  assertEquals(
    fallback.includes(outputLanguageBullet(DEFAULT_LOCALE)),
    true,
  );
});

Deno.test("outputLanguageSentence: one sentence for the title prompt", () => {
  assertEquals(outputLanguageSentence("ja"), "Write the answer in Japanese.");
  assertEquals(outputLanguageSentence("en"), "Write the answer in English.");
});
