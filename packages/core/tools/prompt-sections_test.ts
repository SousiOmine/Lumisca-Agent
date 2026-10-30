import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Api, Model, StreamFn } from "../ai/types.ts";
import type { Workspace } from "../types/workspace.ts";
import { SessionAttachmentStore } from "../session/attachments.ts";
import { SessionVisualStore } from "../session/visuals.ts";
import { AskHub } from "./ask.ts";
import { BackgroundProcessManager } from "./background.ts";
import { TodoHub } from "./todo.ts";
import { TaskHub } from "./task-hub.ts";
import { createCodingTools, hostBackends } from "./toolsets.ts";
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
  TOOL_ASYNC_BASH_KILL,
  TOOL_ASYNC_BASH_STATUS,
  TOOL_BASH,
  TOOL_CHAT_ATTACH,
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
  TOOL_VISUAL,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from "../shared/tool-names.ts";

/** Every tool a coding session preloads, built the way the session factory
 * builds it (agent/factory.ts) instead of being copied by hand: the
 * hand-written list this replaced had already drifted (it was missing the
 * async_bash status/kill pair). */
const CODING_TOOLS = codingToolNames();

/** Preloaded tools that deliberately have no guideline section: their
 * contract (arguments, result markers) is stated in full by the tool's own
 * description and there is no cross-call guidance to add — see the split of
 * responsibilities in prompt-sections.ts. Adding a name here is a statement
 * that the tool needs no section, never a way to quiet a forgotten one. */
const NO_SECTION_TOOLS: readonly string[] = [
  TOOL_LIST_DIR,
  TOOL_ASYNC_BASH_STATUS,
  TOOL_ASYNC_BASH_KILL,
  TOOL_TASK_OUTPUT,
];

/** Build the coding tool set the way the session factory does, and return
 * its tool names. The hubs are the real (cheap) ones; the sub-agent runtime
 * resolver is a stub that never spawns anything, because the tool *set* is
 * what is under test here. */
function codingToolNames(): string[] {
  const workspace: Workspace = {
    id: "w1",
    name: "ws",
    folders: [Deno.cwd()],
    createdAt: 0,
    chat: false,
  };
  return createCodingTools(workspace, {
    background: new BackgroundProcessManager(),
    ask: new AskHub("s1", () => {}),
    todo: new TodoHub("s1", () => {}),
    task: new TaskHub({
      sessionId: "s1",
      resolveRuntime: () => ({
        workspace,
        backends: hostBackends(workspace),
        model: { id: "m", name: "m" } as unknown as Model<Api>,
        thinkingLevel: "off",
        eval: true,
      }),
      streamFn: (() => {
        throw new Error("no sub-agent run in this test");
      }) as unknown as StreamFn,
      emit: () => {},
    }),
    attach: {
      store: new SessionAttachmentStore(
        join(tmpdir(), "lumisca-sections-test"),
      ),
      sessionId: "s1",
    },
    visuals: {
      store: new SessionVisualStore(join(tmpdir(), "lumisca-sections-test")),
      sessionId: "s1",
    },
  }).map((tool) => tool.name);
}

Deno.test("every tool a coding session preloads has a guideline section", () => {
  const covered = new Set(
    CODING_PROMPT_SECTIONS.flatMap((section) => section.requires ?? []),
  );
  const unguided = CODING_TOOLS.filter(
    (name) => !covered.has(name) && !NO_SECTION_TOOLS.includes(name),
  );
  assertEquals(
    unguided,
    [],
    "a preloaded tool needs a guideline section, or an entry in " +
      "NO_SECTION_TOOLS saying why it needs none",
  );
  // The invariant is only meaningful while the built set is the full one
  // (an option-gated tool silently missing would make this test vacuous).
  for (const gated of [TOOL_ASK, TOOL_TODO, TOOL_TASK, TOOL_CHAT_ATTACH]) {
    assertEquals(CODING_TOOLS.includes(gated), true, `${gated} must be built`);
  }
});

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
  assert(all.includes("non-zero exit code"), "bash guidance expected");
  assert(all.includes("async_bash"), "async_bash guidance expected");
  assert(all.includes("Delegate independent work"), "task guidance expected");
  assert(all.includes("Prioritize correctness"), "quality guidance expected");

  // The notification rule covers every notification source, so it renders
  // only when all of them can reach the session.
  const withoutTask = CODING_TOOLS.filter((name) => name !== TOOL_TASK);
  assertEquals(
    renderPromptSections(CODING_PROMPT_SECTIONS, withoutTask)
      .includes("[Background command ...]"),
    false,
    "the notification rule needs every tool that produces one",
  );

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

Deno.test("the file bullet follows the tool it needs", () => {
  // The diagram needs no tool (the client renders the fence), so its bullet
  // reaches every session; the file bullet needs chat_attach, and must not
  // point a session at a tool it lacks.
  const chat = renderPromptSections(CHAT_PROMPT_SECTIONS, [TOOL_ASK]);
  assert(chat.includes("```svg"), "the diagram bullet is unconditional");
  assertEquals(chat.includes("chat_attach"), false);

  const coding = renderPromptSections(CODING_PROMPT_SECTIONS, CODING_TOOLS);
  assert(coding.includes("chat_attach"));
  assertEquals(
    renderPromptSections(
      CODING_PROMPT_SECTIONS,
      CODING_TOOLS.filter((name) => name !== TOOL_CHAT_ATTACH),
    ).includes("chat_attach"),
    false,
    "the file bullet requires chat_attach",
  );
  // Code mode keeps the visual tool as well: it is the way to put an image
  // INSIDE the reply, while chat_attach hands a file over as a card.
  assertEquals(CODING_TOOLS.includes(TOOL_VISUAL), true);
  assert(coding.includes("publish it with the visual"), coding);
  assertEquals(
    renderPromptSections(
      CODING_PROMPT_SECTIONS,
      CODING_TOOLS.filter((name) => name !== TOOL_VISUAL),
    ).includes("publish it with the visual"),
    false,
    "the image bullet requires the visual tool",
  );
});

Deno.test("the web-search bullet follows the pair it is about", () => {
  // A session without a configured provider has no web tools, and must not be
  // told to search: the bullet names only tools that are there.
  const withoutWeb = renderPromptSections(CODING_PROMPT_SECTIONS, [
    TOOL_READ,
    TOOL_BASH,
  ]);
  assertEquals(withoutWeb.includes("web_search"), false);

  // Half the pair is not enough: a session that can search but not read the
  // page in full would be pointed at a tool it lacks.
  assertEquals(
    renderPromptSections(CODING_PROMPT_SECTIONS, [TOOL_WEB_SEARCH])
      .includes("Use web_search"),
    false,
  );

  const withWeb = renderPromptSections(CODING_PROMPT_SECTIONS, [
    TOOL_WEB_SEARCH,
    TOOL_WEB_FETCH,
  ]);
  assert(withWeb.includes("Use web_search for anything that is not"));

  // The chat set carries the same bullet for the same reason.
  assert(
    renderPromptSections(CHAT_PROMPT_SECTIONS, [
      TOOL_WEB_SEARCH,
      TOOL_WEB_FETCH,
    ])
      .includes("Use web_search"),
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
