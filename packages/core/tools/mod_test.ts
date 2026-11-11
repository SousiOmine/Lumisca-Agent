import { assert, assertEquals } from "@std/assert";
import type { Workspace } from "../domain/workspace.ts";
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
import { CARD_HELP } from "../shared/ui-markup/help.ts";
import {
  buildChatSystemPrompt,
  buildStellaSystemPrompt,
  buildSystemPrompt,
  sessionSkills,
} from "./mod.ts";

/** Every tool a coding session preloads (the set the prompt must not
 * name). */
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
  for (const opts of [undefined, {}, { browserAvailable: false }]) {
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
  for (const opts of [
    undefined,
    {},
    { computerAvailable: false },
    { browserAvailable: true },
  ]) {
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

Deno.test("coding prompt carries the workspace and nothing that drifts", () => {
  const prompt = buildSystemPrompt(workspace);
  assert(prompt.includes("You are Lumisca, a coding agent"));
  assert(prompt.includes("The workspace contains these folders"));
  // No guidelines and no tool names: the prompt does not restate the tools
  // (their descriptions carry their own contract) and must not name one,
  // because the tool set changes with the extras while the prompt has to
  // regenerate identically for an unchanged session.
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

Deno.test("coding prompt never mentions a tool", () => {
  // The set is not an input any more: a prompt that named the tools would
  // change whenever a backend detached or an MCP server was added, and the
  // session would rewrite its head on an event that has nothing to do with
  // the instructions.
  //
  // The card paragraph is scanned out: it is a constant of the reply, not of
  // the tool set, so it cannot go stale with a backend, and it says "read"
  // as an ordinary verb ("fields are read as ...").
  const prompt = buildSystemPrompt(workspace).replace(CARD_HELP, "");
  for (const name of CODING_TOOLS) {
    assertEquals(
      prompt.includes(name),
      false,
      `${name} must not be named in the prompt`,
    );
  }
});

Deno.test("every prompt whose reply a person reads teaches the card grammar", () => {
  // The grammar used to live in a prompt-sections module that only the
  // sub-agent prompt rendered, so no main session was ever told how to write
  // a card: the screen drew plain lists where a Choice belonged, and nothing
  // failed. The three builders are the whole set of prompts a reader sees.
  for (const prompt of [
    buildSystemPrompt(workspace),
    buildChatSystemPrompt(),
    buildStellaSystemPrompt(),
  ]) {
    assert(prompt.includes(CARD_HELP), prompt.slice(0, 200));
    // The fence is what makes a block a card; a prompt that named the tags
    // but not the fence would still produce plain markdown.
    assert(prompt.includes("fenced code block"), prompt.slice(0, 200));
  }
});

Deno.test("chat prompt is the folder-less framing alone", () => {
  const prompt = buildChatSystemPrompt();
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
});
