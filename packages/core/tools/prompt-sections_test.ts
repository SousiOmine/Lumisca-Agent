import { assert, assertEquals } from "@std/assert";
import {
  CHAT_PROMPT_SECTIONS,
  CODING_PROMPT_SECTIONS,
  EXPLORE_SUBAGENT_SECTIONS,
  GENERAL_SUBAGENT_SECTIONS,
  renderPromptSections,
} from "./prompt-sections.ts";
import { subagentSystemPrompt } from "./subagent-format.ts";
import {
  TOOL_ASK,
  TOOL_ASYNC_BASH,
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_EVAL,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LIST_DIR,
  TOOL_READ,
  TOOL_SEND_MESSAGE,
  TOOL_SKILL,
  TOOL_TASK,
  TOOL_TASK_OUTPUT,
  TOOL_TODO,
  TOOL_WRITE,
} from "../shared/tool-names.ts";

/** Every tool a coding session preloads. */
const CODING_TOOLS = [
  TOOL_READ,
  TOOL_WRITE,
  TOOL_EDIT,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_LIST_DIR,
  TOOL_BASH,
  TOOL_ASYNC_BASH,
  TOOL_EVAL,
  TOOL_ASK,
  TOOL_TODO,
  TOOL_SKILL,
  TOOL_TASK,
];

/** The tools of a `general` sub-agent that can delegate further. */
const GENERAL_TOOLS = [
  TOOL_READ,
  TOOL_WRITE,
  TOOL_EDIT,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_LIST_DIR,
  TOOL_BASH,
  TOOL_EVAL,
  TOOL_SKILL,
  TOOL_SEND_MESSAGE,
  TOOL_TASK,
  TOOL_TASK_OUTPUT,
];

/** The tools of an `explore` sub-agent (read-only, never delegates). */
const EXPLORE_TOOLS = [
  TOOL_READ,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_LIST_DIR,
  TOOL_SKILL,
  TOOL_SEND_MESSAGE,
];

/** The `- ` bullets of a rendered guideline block. */
function bullets(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("- "));
}

// --- visibility gating -------------------------------------------------------

Deno.test("renderPromptSections renders only the sections the tools satisfy", () => {
  const all = renderPromptSections(CODING_PROMPT_SECTIONS, CODING_TOOLS);
  assert(all.includes("`[exit code: N]`"), "bash guidance expected");
  assert(all.includes("async_bash"), "async_bash guidance expected");
  assert(all.includes("[Task ...]"), "task guidance expected");
  assert(all.includes("Prioritize correctness"), "quality guidance expected");

  const readOnly = renderPromptSections(CODING_PROMPT_SECTIONS, [TOOL_READ]);
  assert(readOnly.includes("Use read to inspect files"), "read expected");
  assertEquals(
    readOnly.includes("async_bash"),
    false,
    "guidance for an absent tool must not render",
  );
  assertEquals(readOnly.includes("[Task ...]"), false);
  assertEquals(
    readOnly.includes("Prioritize correctness"),
    true,
    "unconditional sections always render",
  );

  assertEquals(
    renderPromptSections(CODING_PROMPT_SECTIONS, []).includes("Tool"),
    false,
  );
});

Deno.test("sections render in a stable order regardless of the tool set order", () => {
  const forward = renderPromptSections(CODING_PROMPT_SECTIONS, CODING_TOOLS);
  const reversed = renderPromptSections(
    CODING_PROMPT_SECTIONS,
    [...CODING_TOOLS].reverse(),
  );
  assertEquals(forward, reversed);
});

Deno.test("every section has a unique name", () => {
  const sets = [
    CODING_PROMPT_SECTIONS,
    CHAT_PROMPT_SECTIONS,
    EXPLORE_SUBAGENT_SECTIONS,
    GENERAL_SUBAGENT_SECTIONS,
  ];
  for (const sections of sets) {
    const names = sections.map((section) => section.name);
    assertEquals(
      new Set(names).size,
      names.length,
      `duplicate section name in ${JSON.stringify(names)}`,
    );
  }
});

Deno.test("one bullet per section: no section packs unrelated rules together", () => {
  for (
    const section of [
      ...CODING_PROMPT_SECTIONS,
      ...CHAT_PROMPT_SECTIONS,
      ...EXPLORE_SUBAGENT_SECTIONS,
      ...GENERAL_SUBAGENT_SECTIONS,
    ]
  ) {
    assertEquals(
      section.text.startsWith("- "),
      true,
      `section ${section.name} must start with a bullet`,
    );
    // A section is one rule (possibly wrapped over several lines) with a
    // description; the deliberately multi-bullet ones are the quality and
    // workflow groups, which exist to keep the tail of the prompt stable.
    const count = bullets(section.text).length;
    if (!["quality", "workflow", "chat:answers"].includes(section.name)) {
      assertEquals(
        count,
        1,
        `section ${section.name} holds ${count} bullets`,
      );
    }
  }
});

// --- sub-agent prompts -------------------------------------------------------

Deno.test("sub-agent prompt carries its identity and the kind's guidelines", () => {
  const explore = subagentSystemPrompt(
    "agent_2",
    "agent_1",
    "explore",
    EXPLORE_TOOLS,
  );
  assert(explore.includes("research sub-agent of Lumisca"));
  assert(explore.includes("Your own id is agent_2"));
  assert(explore.includes("send a message to agent_1"));
  assert(explore.includes("- You are read-only"));
  assert(explore.includes("Be thorough before concluding"));

  const general = subagentSystemPrompt(
    "agent_3",
    "session-1",
    "general",
    GENERAL_TOOLS,
  );
  assert(general.includes("coding sub-agent of Lumisca"));
  assert(general.includes("Make the final report self-contained"));
  assert(general.includes("- You can delegate independent work"));
  assertEquals(
    general.includes("You are read-only"),
    false,
    "a general sub-agent is not read-only",
  );
});

Deno.test("sub-agent delegation guidance follows the tool set, not the kind", () => {
  // A general sub-agent at the depth limit has no task tool: the delegation
  // bullet must not show up (it would point at a tool it does not have).
  const shallow = subagentSystemPrompt("agent_2", "agent_1", "general", [
    ...GENERAL_TOOLS.filter((name) =>
      name !== TOOL_TASK && name !== TOOL_TASK_OUTPUT
    ),
  ]);
  assertEquals(shallow.includes("delegate independent work"), false);
  assert(shallow.includes("Make the final report self-contained"));

  // Every sub-agent can reach its parent, so the message rule stays.
  assert(shallow.includes("[Message from ...]"));
});

Deno.test("sub-agent sections render safely without any tool", () => {
  const prompt = subagentSystemPrompt("agent_2", "agent_1", "explore", []);
  assert(prompt.includes("Guidelines:"));
  assertEquals(
    prompt.includes("- You are read-only"),
    false,
    "read-only guidance needs the read-only tools",
  );
});

Deno.test("the sub-agent kinds share only the message rule", () => {
  const names = (sections: readonly { name: string }[]) =>
    sections.map((section) => section.name);
  const shared = names(EXPLORE_SUBAGENT_SECTIONS).filter((name) =>
    names(GENERAL_SUBAGENT_SECTIONS).includes(name)
  );
  assertEquals(shared, ["subagent:message"]);
});
