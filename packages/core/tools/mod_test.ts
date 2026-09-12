import { assert, assertEquals } from "@std/assert";
import {
  buildChatSystemPrompt,
  buildSystemPrompt,
  sessionSkills,
} from "./mod.ts";
import type { Workspace } from "../types/workspace.ts";
import {
  TOOL_ASK,
  TOOL_ASYNC_BASH,
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_EVAL,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_READ,
  TOOL_SKILL,
  TOOL_TASK,
  TOOL_TODO,
  TOOL_WRITE,
} from "../shared/tool-names.ts";
import {
  CHAT_PROMPT_SECTIONS,
  CODING_PROMPT_SECTIONS,
  renderPromptSections,
} from "./prompt-sections.ts";

/** Every tool a coding session preloads (the set the guideline sections
 * key on). */
const CODING_TOOLS = [
  TOOL_READ,
  TOOL_WRITE,
  TOOL_EDIT,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_BASH,
  TOOL_ASYNC_BASH,
  TOOL_EVAL,
  TOOL_ASK,
  TOOL_TODO,
  TOOL_SKILL,
  TOOL_TASK,
];

/** A folder-less workspace for prompt tests (no project memory, no
 * workspace skills — the skill set is global + built-in skills only). */
const workspace: Workspace = {
  id: "ws_test",
  name: "test",
  folders: [],
  createdAt: 0,
  chat: false,
};

// --- sessionSkills gating ----------------------------------------------------

Deno.test("sessionSkills advertises the web-browser skill only with a browser backend", () => {
  const withBrowser = sessionSkills([], { browserAvailable: true });
  assert(
    withBrowser.some((s) => s.name === "web-browser"),
    "web-browser must be advertised when the browser backend is attached",
  );
  for (
    const opts of [
      undefined,
      {},
      { browserAvailable: false },
    ]
  ) {
    const without = sessionSkills([], opts as { browserAvailable?: boolean });
    assertEquals(
      without.some((s) => s.name === "web-browser"),
      false,
      `web-browser must not be advertised for ${JSON.stringify(opts)}`,
    );
  }
});

// --- section visibility ------------------------------------------------------

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

// --- prompt contents ---------------------------------------------------------

Deno.test("coding prompt carries the workspace and the tool guidance it has", () => {
  const prompt = buildSystemPrompt(workspace, { tools: CODING_TOOLS });
  assert(prompt.includes("You are Lumisca, a coding agent"));
  assert(prompt.includes("The workspace contains these folders"));
  assert(prompt.includes("Environment:"));
  assert(
    prompt.includes(TOOL_TASK),
    "task guidance expected with the task tool",
  );
  // The skill catalog and the instruction files are dynamic context, not
  // prompt text: they are published as transcript messages.
  assertEquals(prompt.includes("<available_skills>"), false);
  assertEquals(prompt.includes("Project memory"), false);
  assertEquals(prompt.includes("web-browser"), false);
});

Deno.test("coding prompt never mentions a tool the session does not have", () => {
  const prompt = buildSystemPrompt(workspace, { tools: [TOOL_READ] });
  for (
    const absent of [
      "async_bash",
      "`eval`",
      "[Task ...]",
      "todo tool",
      "send_message",
      "present tool",
    ]
  ) {
    assertEquals(
      prompt.includes(absent),
      false,
      `${absent} must not be mentioned without its tool`,
    );
  }
});

Deno.test("chat prompt lists only the chat guidelines", () => {
  const prompt = buildChatSystemPrompt({
    tools: [TOOL_ASK, TOOL_TODO, TOOL_SKILL],
  });
  assert(prompt.includes("You are Lumisca, a helpful AI assistant."));
  assert(prompt.includes("Write answers with future readers in mind."));
  assert(prompt.includes("Ask the user when a task is ambiguous."));
  assertEquals(
    prompt.includes("`[exit code: N]`"),
    false,
    "chat sessions have no shell",
  );
  assertEquals(prompt.includes("The workspace contains these folders"), false);
  assertEquals(
    renderPromptSections(CHAT_PROMPT_SECTIONS, [TOOL_ASK]).includes("todo"),
    false,
    "a chat session without the todo tool gets no todo guidance",
  );
});
