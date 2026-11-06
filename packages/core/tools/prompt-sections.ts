import {
  TOOL_ASK,
  TOOL_ASYNC_BASH,
  TOOL_BASH,
  TOOL_CHAT_ATTACH,
  TOOL_EDIT,
  TOOL_EVAL,
  TOOL_LIST_DIR,
  TOOL_READ,
  TOOL_SEND_CHAT,
  TOOL_SEND_MESSAGE,
  TOOL_SKILL,
  TOOL_TASK,
  TOOL_TODO,
  TOOL_VISUAL,
  TOOL_VM_ACT,
  TOOL_VM_ASK_USER,
  TOOL_VM_FIND,
  TOOL_VM_LAUNCH,
  TOOL_VM_SCREENSHOT,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from "../shared/tool-names.ts";

/**
 * The system prompt's guideline sections.
 *
 * Split of responsibilities with the tool definitions (the layering the DeepSeek
 * Harness uses): a tool's `description` states the contract of ONE call — what
 * it does, how to build its arguments, and the exact markers its result carries
 * on truncation or failure — while cross-call guidance lives here, as a prompt
 * section. A bullet therefore never restates what its tool's description (or
 * one of its arguments) already says: it carries the guidance the description
 * cannot, such as when to reach for the tool, which tool to prefer, and how to
 * react to a result. A section can require tools: it is rendered only when
 * every tool it names is part of the session's preloaded tool set, so a session
 * can never be told about a tool it does not have (the same coupling DSH
 * expresses with `ctx.tools.get(name, scope) === undefined ? '' : …`).
 */

/** One guideline section of the system prompt. */
export interface PromptSection {
  /** Stable name; sections with equal orders sort by it. */
  name: string;
  /** Ascending order of the rendered bullets. */
  order: number;
  /** Tool names that must all be preloaded for the section to render.
   * Omitted → the section always renders (in its prompt). */
  requires?: readonly string[];
  /** Bullet text (one or more lines, each starting with "- "). */
  text: string;
}

/** True when every tool the section requires is part of `toolNames`. */
function isVisible(
  section: PromptSection,
  toolNames: ReadonlySet<string>,
): boolean {
  return (section.requires ?? []).every((name) => toolNames.has(name));
}

/**
 * Render the guideline bullet text of the sections visible for `toolNames`,
 * in ascending order (equal orders sort by name, so the output is stable
 * across runs and prompt-cache friendly).
 */
export function renderPromptSections(
  sections: readonly PromptSection[],
  toolNames: Iterable<string>,
): string {
  const available = toolNames instanceof Set
    ? toolNames as ReadonlySet<string>
    : new Set(toolNames);
  return sections
    .filter((section) => isVisible(section, available))
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1))
    .map((section) => section.text)
    .join("\n");
}

/** Section orders, grouped by concern. Every group owns a range of its own,
 * so the rendered block walks the groups in order (workspace, tools,
 * notifications, quality, workflow, chat) and a section can never land in
 * the middle of another group. Gaps leave room for new sections without
 * renumbering (the same reason DSH allocates its section orders centrally). */
const ORDER = {
  workspace: 0,
  tool: 100,
  notification: 250,
  quality: 300,
  workflow: 400,
  chat: 500,
} as const;

// --- workspace ---------------------------------------------------------------

const PATHS_SECTION: PromptSection = {
  name: "workspace:paths",
  order: ORDER.workspace,
  text:
    "- Paths are either absolute or relative to the workspace. A relative " +
    "path must\n  start with the name of a workspace folder above, e.g. " +
    "`Aaa/README.md`.",
};

// --- tool guidance -----------------------------------------------------------

const READ_SECTION: PromptSection = {
  name: "tool:read",
  order: ORDER.tool,
  requires: [TOOL_READ],
  text: "- Use read to inspect files instead of shell commands like `cat`.",
};

const WRITE_SECTION: PromptSection = {
  name: "tool:write",
  order: ORDER.tool + 10,
  requires: [TOOL_WRITE],
  text: "- Use write to create a file or replace one wholesale; prefer edit " +
    "for a targeted change.",
};

const EDIT_SECTION: PromptSection = {
  name: "tool:edit",
  order: ORDER.tool + 20,
  requires: [TOOL_EDIT],
  text: "- Use edit for targeted changes: one literal replacement per call, " +
    "and re-read\n  the file when the match fails.",
};

const BASH_SECTION: PromptSection = {
  name: "tool:bash",
  order: ORDER.tool + 30,
  requires: [TOOL_BASH],
  text:
    "- Search with the shell: grep for contents, find for paths (both beat " +
    "reading\n  files one by one). Investigate a non-zero exit code before " +
    "moving on; an\n  empty result is never proof of success.",
};

const ASYNC_BASH_SECTION: PromptSection = {
  name: "tool:async_bash",
  order: ORDER.tool + 40,
  requires: [TOOL_ASYNC_BASH],
  text: "- Use async_bash for long-running work; check it with " +
    "async_bash_status and stop\n  it with async_bash_kill when done.",
};

const EVAL_SECTION: PromptSection = {
  name: "tool:eval",
  order: ORDER.tool + 50,
  requires: [TOOL_EVAL],
  text: "- Use eval for quick calculations and data processing instead of " +
    "spawning\n  python or node from bash.",
};

const ASK_SECTION: PromptSection = {
  name: "tool:ask",
  order: ORDER.tool + 90,
  requires: [TOOL_ASK],
  text: "- Ask the user when a task is ambiguous.",
};

const TODO_SECTION: PromptSection = {
  name: "tool:todo",
  order: ORDER.tool + 100,
  requires: [TOOL_TODO],
  text: "- Keep the todo list current as you go: mark each task `completed` " +
    "the moment\n  it is done — do not batch completions. Skip the list for " +
    "a single trivial step.",
};

const SKILL_SECTION: PromptSection = {
  name: "tool:skill",
  order: ORDER.tool + 110,
  requires: [TOOL_SKILL],
  text: "- Load a skill before starting work that matches one in the " +
    "catalog.",
};

/** The web tools. One bullet, keyed on the search half: a session that can
 * search is the one that needs to be told how the pair is meant to be used
 * (and that what it reads is data, not orders). */
const WEB_SEARCH_SECTION: PromptSection = {
  name: "tool:web_search",
  order: ORDER.tool + 112,
  requires: [TOOL_WEB_SEARCH, TOOL_WEB_FETCH],
  text: "- Use web_search for anything that is not in this repository or not " +
    "in your\n  knowledge: a current API, a version, an error message you " +
    "do not recognise.\n  Prefer the project's own code and documentation " +
    "when they answer the question.",
};

/** Both halves of the visual feature, each a section of its own: a diagram
 * needs no tool, an image file needs the visual tool. */
const VISUAL_DIAGRAM_SECTION: PromptSection = {
  name: "visual:diagram",
  order: ORDER.tool + 115,
  text: "- To show a diagram in your reply, put the complete `<svg>` element " +
    "inside a\n  fenced block opened with ```svg and closed with ``` (no " +
    "script, up to\n  256 KiB). The fence is what makes it a picture: an " +
    "`<svg>` element written\n  outside a fence reaches the reader as source " +
    "text.",
};

/** Code mode's way of putting an image INSIDE the reply: the visual tool
 * publishes the file and returns the markdown to paste. A conversation
 * (stella) does not use it — there a file is sent with `send_chat` and
 * appears with the message (see SEND_CHAT_SECTION). */
const VISUAL_IMAGE_SECTION: PromptSection = {
  name: "visual:image",
  order: ORDER.tool + 128,
  requires: [TOOL_VISUAL],
  text: "- To show an image file inside your reply, publish it with the " +
    "visual tool and\n  paste the markdown snippet it returns where the " +
    "image belongs.",
};

/** Showing a file the agent produced, in code mode: `chat_attach` hands it
 * to the user as a card under the reply (an image inline, anything else as a
 * download). Keyed on the tool: a session without one must not be told to
 * send files, and an agent that does not know it can will paste the path
 * instead and leave the user to go find it. */
const CHAT_ATTACH_SECTION: PromptSection = {
  name: "tool:chat_attach",
  order: ORDER.tool + 125,
  requires: [TOOL_CHAT_ATTACH],
  text: "- To give the user a file, send it with chat_attach rather than " +
    "writing its path\n  for them to open.",
};

/** The machine's widgets, in a stella session. Keyed on the tools: an agent
 * that cannot find an element must not be told to look for one.
 *
 * The bullets say which of the two families to reach for, because that is the
 * one thing neither tool's description can decide for the agent: the screen
 * tools work in pixels and the semantic tools work in names, and the same
 * window can be driven either way. */
const VM_FIND_SECTION: PromptSection = {
  name: "vm:find",
  order: ORDER.tool + 142,
  requires: [TOOL_VM_FIND],
  text:
    "- Reach for vm_find + vm_do before coordinates: a control addressed by " +
    "role and\n  name is the control that is acted on, and the result says " +
    "what changed.",
};

/** The machine's screen, in a stella session. Both halves are keyed on the
 * tools: an agent that cannot look must not be told to check what it sees,
 * and one that cannot act must not be told to click.
 *
 * The bullets say WHEN to look and what to prefer, not what the tools do:
 * `vm_screenshot` and `vm_act` describe their own coordinates, their actions
 * and the fact that an image pixel is a screen pixel. */
const VM_SCREENSHOT_SECTION: PromptSection = {
  name: "vm:screenshot",
  order: ORDER.tool + 140,
  requires: [TOOL_VM_SCREENSHOT],
  text: "- Use vm_screenshot to SEE a window (layout, whether something " +
    "rendered, what an\n  image shows) and again after an action, to see " +
    "what it did.",
};

const VM_ACT_SECTION: PromptSection = {
  name: "vm:act",
  order: ORDER.tool + 150,
  requires: [TOOL_VM_ACT],
  text:
    "- Use vm_act for the GUI: a browser, a dialog. Prefer the shell and the " +
    "file\n  tools for everything they can do — a command is faster and " +
    "leaves a record.",
};

/** Starting a program on the machine's screen. Keyed on its tool, like the
 * other machine sections. */
const VM_LAUNCH_SECTION: PromptSection = {
  name: "vm:launch",
  order: ORDER.tool + 146,
  requires: [TOOL_VM_LAUNCH],
  text: "- The machine has a display but no desktop menu: a program that is " +
    'not started\n  with vm_launch has no window. `action: "list"` says ' +
    "what is installed — check\n  it instead of assuming a name.",
};

/** Handing the screen to the user. Keyed on the tool: an agent that cannot
 * ask has no way to get past a password, and would try to type it.
 *
 * The one rule the tool's description does not carry: a secret typed into
 * the chat is written into a transcript that outlives the moment. */
const VM_ASK_USER_SECTION: PromptSection = {
  name: "vm:ask_user",
  order: ORDER.tool + 155,
  requires: [TOOL_VM_ASK_USER],
  text:
    "- Never ask the user to send a secret as a chat message — it would be " +
    "written\n  into the transcript.",
};

/** When the user should hear from the agent before the reply.
 *
 * The tool's description states the contract of one call (send before long
 * work, what to put in it, one call is one message), and repeating that here
 * would cost every request and drift from it. What a description cannot say
 * — it describes a call, not a run — is that the wait itself is the
 * problem: a run that says nothing until it ends reads as a hang, however
 * well the note it finally sends is written. One line, because that is the
 * whole of the guidance. */
const SEND_CHAT_SECTION: PromptSection = {
  name: "tool:send_chat",
  order: ORDER.tool + 158,
  requires: [TOOL_SEND_CHAT],
  text:
    "- send_chat is how the user hears from you before the work is done: a " +
    "short note\n  before a long task, and another when it turns, keeps them " +
    "from waiting blind.",
};

const TASK_SECTION: PromptSection = {
  name: "tool:task",
  order: ORDER.tool + 130,
  requires: [TOOL_TASK],
  text: "- Delegate independent work to sub-agents with task and keep " +
    "working while they\n  run; wait for one with task_output when your " +
    "next step depends on it.",
};

// --- system notifications ----------------------------------------------------

/** Notifications arrive as user-role messages, so one section covers them
 * all. A coding session always has both the background-command manager and
 * the task hub (factory.ts builds them together for non-chat sessions),
 * which is exactly when a notification can appear. The `[warning]` a
 * truncated sub-agent report carries is explained by the task_output
 * description and repeated in the warning itself (subagent-format.ts), so
 * it needs no bullet here. */
const NOTIFICATION_SECTION: PromptSection = {
  name: "notification:system",
  order: ORDER.notification,
  requires: [TOOL_ASYNC_BASH, TOOL_TASK],
  text: '- A user message starting with "[Background command ...]", "[Task ' +
    '...]"\n  or "[Message from ...]" is a system notification, not from the ' +
    "user: acknowledge\n  it and carry on. Do not poll a running background " +
    "command.",
};

// --- quality and workflow ----------------------------------------------------

/** The rules that hold for every session, whatever its tools.
 *
 * Deliberately short. A long list of good advice is read once and then
 * skipped — the rules that change behaviour are the ones a model would
 * otherwise get wrong (inventing results, quietly shrinking the task,
 * reporting work it did not verify). Everything else is the tool
 * descriptions' job. */
const QUALITY_SECTION: PromptSection = {
  name: "quality",
  order: ORDER.quality,
  text: "- Prioritize correctness. Never fabricate tool or test results, " +
    "never narrow the\n  requested scope silently, and verify your changes " +
    "before reporting them.",
};

const WORKFLOW_SECTION: PromptSection = {
  name: "workflow",
  order: ORDER.workflow,
  text: "- For multi-file changes, plan before editing and fix root causes " +
    "rather than\n  symptoms. Do not hand in TODOs or placeholders. Say so " +
    "when something could not\n  be checked.",
};

// --- chat-only ---------------------------------------------------------------

const CHAT_ANSWERS_SECTION: PromptSection = {
  name: "chat:answers",
  order: ORDER.chat,
  text: "- Write answers with future readers in mind; do not hand in " +
    "placeholder content as finished work.",
};

// --- sub-agent guidelines ----------------------------------------------------

const SUBAGENT_MESSAGE_SECTION: PromptSection = {
  name: "subagent:message",
  order: ORDER.notification,
  requires: [TOOL_SEND_MESSAGE],
  // Keyed on the tool, not on the agent kind: the main coding session has
  // send_message too (it receives "[Message from ...]" notifications from
  // its sub-agents), so CODING_PROMPT_SECTIONS carries this section as well.
  text: '- A message starting with "[Message from ...]" is a message from ' +
    "another agent,\n  not from the user: answer it with send_message or " +
    "fold it into your work.",
};

const SUBAGENT_READ_ONLY_SECTION: PromptSection = {
  name: "subagent:read-only",
  order: ORDER.tool,
  requires: [TOOL_READ, TOOL_BASH, TOOL_LIST_DIR],
  text: "- You are read-only: investigate with read/list_dir, the shell " +
    "(grep, find,\n  git log, ...) and skill, and report findings with file " +
    "references (path:line).\n  Never modify files: no write / edit, and no " +
    "shell command with side effects.",
};

const SUBAGENT_THOROUGH_SECTION: PromptSection = {
  name: "subagent:thorough",
  order: ORDER.quality,
  text: "- Be thorough before concluding: the parent agent relies on your " +
    "report.",
};

const SUBAGENT_DELEGATE_SECTION: PromptSection = {
  name: "subagent:delegate",
  order: ORDER.notification,
  requires: [TOOL_TASK],
  text: "- You can delegate independent work to further sub-agents with the " +
    "task tool:\n  they start in the background, so keep working while they " +
    'run. Their completion\n  arrives as a "[Task ...]" notification, or use ' +
    "task_output (wait: true) when\n  your next step depends on the result.",
};

const SUBAGENT_REPORT_SECTION: PromptSection = {
  name: "subagent:report",
  order: ORDER.quality,
  text: "- Make the final report self-contained: what you did, what you " +
    "found, and what\n  remains open.",
};

/** Guideline sections of a coding session's system prompt. */
export const CODING_PROMPT_SECTIONS: readonly PromptSection[] = [
  PATHS_SECTION,
  READ_SECTION,
  WRITE_SECTION,
  EDIT_SECTION,
  BASH_SECTION,
  ASYNC_BASH_SECTION,
  EVAL_SECTION,
  ASK_SECTION,
  TODO_SECTION,
  SKILL_SECTION,
  WEB_SEARCH_SECTION,
  VISUAL_DIAGRAM_SECTION,
  VISUAL_IMAGE_SECTION,
  CHAT_ATTACH_SECTION,
  TASK_SECTION,
  NOTIFICATION_SECTION,
  // The same rule a sub-agent gets: a "[Message from ...]" notification is
  // another agent talking, not the user (the session's sub-agents message it
  // back). Gated on send_message, so a session without the task tools never
  // renders it.
  SUBAGENT_MESSAGE_SECTION,
  QUALITY_SECTION,
  WORKFLOW_SECTION,
];

/** Guideline sections of a stella session's system prompt: the coding set
 * minus the workspace framing (there is no workspace picker in stella) plus
 * the machine's screen guidance. The machine is the working area, so the
 * file/shell sections apply exactly as they do in a workspace.
 *
 * What is absent says as much as what is here: no `ask` (the person answers
 * in words or with a card; there is no panel to block on), no `todo` (no
 * progress panel), no identity or agent_create bullets (those tools are
 * discoverable through tool_search — their built-in skills teach them), and
 * neither a visual nor a chat_attach bullet: `send_chat` is this
 * conversation's only channel, and it carries files itself. */
export const STELLA_PROMPT_SECTIONS: readonly PromptSection[] = [
  // Per-tool sections are mostly absent: a tool's own description already
  // says what it does and when to reach for it, so repeating it here only
  // costs every request (and drifts from the description it copies). What is
  // left is what no tool can carry — how to choose BETWEEN tools, the rules
  // that hold across calls, and the one habit the user waits on (send_chat).
  VM_FIND_SECTION,
  VM_SCREENSHOT_SECTION,
  VM_ACT_SECTION,
  VM_LAUNCH_SECTION,
  VM_ASK_USER_SECTION,
  SEND_CHAT_SECTION,
  NOTIFICATION_SECTION,
  SUBAGENT_MESSAGE_SECTION,
  QUALITY_SECTION,
  WORKFLOW_SECTION,
];

/** Guideline sections of a chat session's system prompt (a folder-less
 * session: no file, shell or sub-agent tools, so their sections never
 * render; `requires` prunes the rest on its own). */
export const CHAT_PROMPT_SECTIONS: readonly PromptSection[] = [
  ASK_SECTION,
  TODO_SECTION,
  SKILL_SECTION,
  WEB_SEARCH_SECTION,
  VISUAL_DIAGRAM_SECTION,
  QUALITY_SECTION,
  CHAT_ANSWERS_SECTION,
];

/** Guideline sections of an `explore` sub-agent (read-only investigation):
 * the identity header is built by the caller — it carries the agent ids —
 * and these sections contribute the behavior keyed on its tool set. */
export const EXPLORE_SUBAGENT_SECTIONS: readonly PromptSection[] = [
  SUBAGENT_MESSAGE_SECTION,
  SUBAGENT_READ_ONLY_SECTION,
  SUBAGENT_THOROUGH_SECTION,
];

/** Guideline sections of a `general` sub-agent (its own coding tool set,
 * plus the search/call pair over the session's registry). */
export const GENERAL_SUBAGENT_SECTIONS: readonly PromptSection[] = [
  SUBAGENT_MESSAGE_SECTION,
  SUBAGENT_DELEGATE_SECTION,
  SUBAGENT_REPORT_SECTION,
];
