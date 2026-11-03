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
  TOOL_READ,
  TOOL_SKILL,
  TOOL_TASK,
  TOOL_TODO,
  TOOL_WRITE,
} from "../shared/tool-names.ts";
import {
  CHAT_PROMPT_SECTIONS,
  renderPromptSections,
} from "./prompt-sections.ts";

/** Every tool a coding session preloads (the set the guideline sections
 * key on). */
const CODING_TOOLS = [
  TOOL_READ,
  TOOL_WRITE,
  TOOL_EDIT,
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

Deno.test("sessionSkills advertises the computer-use skill only when the machine can be driven", () => {
  const withComputer = sessionSkills([], { computerAvailable: true });
  assert(
    withComputer.some((s) => s.name === "computer-use"),
    "computer-use must be advertised when the session may drive the machine",
  );
  for (
    const opts of [
      undefined,
      {},
      { computerAvailable: false },
      { browserAvailable: true },
    ]
  ) {
    const without = sessionSkills(
      [],
      opts as { computerAvailable?: boolean; browserAvailable?: boolean },
    );
    assertEquals(
      without.some((s) => s.name === "computer-use"),
      false,
      `computer-use must not be advertised for ${JSON.stringify(opts)}`,
    );
  }
});

// --- prompt contents ---------------------------------------------------------

Deno.test("coding prompt carries the workspace and the tool guidance it has", () => {
  const prompt = buildSystemPrompt(workspace, { tools: CODING_TOOLS });
  assert(prompt.includes("You are Lumisca, a coding agent"));
  assert(prompt.includes("The workspace contains these folders"));
  // The prompt does NOT restate the tools: each tool's description carries
  // its own contract, and the prompt repeats only the output-language rule
  // (see system-prompt.ts).
  assertEquals(prompt.includes("Guidelines:\n- Use"), false);
  // The machine's specs are not in the prompt: they are stable, cheap to
  // probe from a command, and every line of the prompt is paid for on every
  // request (see environment.ts).
  assertEquals(prompt.includes("Environment:"), false);
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
  // No guidelines at all: the per-tool guidance is the tools' own
  // descriptions, and the reply language is a context message now.
  assertEquals(prompt.includes("Write every reply in"), false);
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
