import { assert, assertEquals } from "@std/assert";
import { DEFAULT_LOCALE } from "../shared/mod.ts";
import { TOOL_READ, TOOL_TODO } from "../shared/tool-names.ts";
import { outputLanguageBullet, outputLanguageSentence } from "./language.ts";
import { buildChatSystemPrompt, buildSystemPrompt } from "./system-prompt.ts";
import { subagentSystemPrompt } from "./subagent-format.ts";
import type { Workspace } from "../types/workspace.ts";

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

Deno.test("outputLanguageSection: leads the guidelines of a coding prompt", () => {
  const prompt = buildSystemPrompt(workspace, {
    tools: TOOLS,
    language: "en",
  });
  const guidelines = prompt.slice(prompt.indexOf("Guidelines:"));
  const firstBullet = guidelines.split("\n").find((line) =>
    line.startsWith("- ")
  );
  assertEquals(firstBullet, outputLanguageBullet("en"));
  // The sections after it are untouched.
  assertEquals(
    prompt.includes("- Prioritize correctness above all else."),
    true,
  );
});

Deno.test("buildSystemPrompt: the session language decides the rule", () => {
  const ja = buildSystemPrompt(workspace, { tools: [], language: "ja" });
  const en = buildSystemPrompt(workspace, { tools: [], language: "en" });
  assertEquals(ja.includes("Write every reply in Japanese"), true);
  assertEquals(en.includes("Write every reply in English"), true);
  assertEquals(ja.includes("Write every reply in English"), false);
  // Omitted → the catalogue's fallback language, never a missing rule.
  const fallback = buildSystemPrompt(workspace, { tools: [] });
  assertEquals(
    fallback.includes(outputLanguageBullet(DEFAULT_LOCALE)),
    true,
  );
});

Deno.test("buildChatSystemPrompt: chat sessions get the rule too", () => {
  const prompt = buildChatSystemPrompt({ tools: [], language: "ja" });
  assertEquals(prompt.includes("Write every reply in Japanese"), true);
  assertEquals(prompt.includes("Guidelines:"), true);
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
