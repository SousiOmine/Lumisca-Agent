import {
  TOOL_AGENT_CREATE,
  TOOL_ASK,
  TOOL_ASYNC_BASH,
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_EVAL,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_HISTORY_SEARCH,
  TOOL_LIST_DIR,
  TOOL_READ,
  TOOL_SEND_MESSAGE,
  TOOL_SKILL,
  TOOL_TASK,
  TOOL_TODO,
  TOOL_VISUAL,
  TOOL_VM_ACT,
  TOOL_VM_SCREENSHOT,
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
  text: "- Use edit for targeted changes: one literal replacement per call. " +
    "Re-read the\n  file when the match fails or it changed.",
};

const GLOB_SECTION: PromptSection = {
  name: "tool:glob",
  order: ORDER.tool + 30,
  requires: [TOOL_GLOB],
  text: "- Use glob to discover files by path pattern instead of shell `find`.",
};

const GREP_SECTION: PromptSection = {
  name: "tool:grep",
  order: ORDER.tool + 40,
  requires: [TOOL_GREP],
  text:
    "- Use grep to search file contents instead of shell `grep`/`rg`, and " +
    "read a\n  matched file for context instead of widening the pattern.",
};

const SEARCH_CAPS_SECTION: PromptSection = {
  name: "tool:search-caps",
  order: ORDER.tool + 50,
  requires: [TOOL_GLOB, TOOL_GREP],
  text: "- A capped search result is not a complete result: narrow the " +
    "pattern or raise\n  `max_results`.",
};

const BASH_SECTION: PromptSection = {
  name: "tool:bash",
  order: ORDER.tool + 60,
  requires: [TOOL_BASH],
  text:
    "- Investigate a non-zero exit code before moving on; an empty result " +
    "is never\n  proof of success.",
};

const ASYNC_BASH_SECTION: PromptSection = {
  name: "tool:async_bash",
  order: ORDER.tool + 70,
  requires: [TOOL_ASYNC_BASH],
  text: "- Use async_bash for long-running work (dev servers, watchers, " +
    "downloads);\n  check it with async_bash_status and stop it with " +
    "async_bash_kill when done.",
};

const EVAL_SECTION: PromptSection = {
  name: "tool:eval",
  order: ORDER.tool + 80,
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

const VISUAL_IMAGE_SECTION: PromptSection = {
  name: "visual:image",
  order: ORDER.tool + 125,
  requires: [TOOL_VISUAL],
  text: "- To show an image file in your reply, publish it with the visual " +
    "tool and\n  paste the markdown snippet it returns where the image " +
    "belongs.",
};

/** The machine's screen, in a stella session. Both halves are keyed on the
 * tools: an agent that cannot look must not be told to check what it sees,
 * and one that cannot act must not be told to click. */
const VM_SCREENSHOT_SECTION: PromptSection = {
  name: "vm:screenshot",
  order: ORDER.tool + 140,
  requires: [TOOL_VM_SCREENSHOT],
  text:
    "- This machine's screen is yours to look at: use vm_screenshot before " +
    "acting on a GUI\n  and after an action to see what it did. The image is " +
    "1:1 with the screen, so a\n  position read off it is a coordinate " +
    "vm_act takes as-is.",
};

const VM_ACT_SECTION: PromptSection = {
  name: "vm:act",
  order: ORDER.tool + 150,
  requires: [TOOL_VM_ACT],
  text:
    "- Use vm_act for the GUI (a browser, a dialog): click, type, scroll, " +
    "press keys.\n  Prefer the shell and the file tools for everything they " +
    "can do — a command is\n  faster and leaves a record, a click does not.",
};

/** The conversation's own history, in a stella session. Keyed on the tool:
 * a session whose history was condensed must be told the earlier turns are
 * still reachable, and one without the tool would be sent looking for it. */
const HISTORY_SEARCH_SECTION: PromptSection = {
  name: "tool:history_search",
  order: ORDER.tool + 135,
  requires: [TOOL_HISTORY_SEARCH],
  text:
    "- This one conversation outlives any single context window: when older " +
    "turns are\n  condensed into a checkpoint, their exact words leave your " +
    "context but stay in the\n  history. Use history_search to look them up " +
    "(by word or by date) before\n  saying that you do not remember, or " +
    "before asking the user to repeat something.",
};

/** Adding a counterpart in a stella session (Terasuma's `tera_create`).
 * The tool cannot ask the questions, so the bullet carries when to reach
 * for it: the user has already said what the new agent should be. */
const AGENT_CREATE_SECTION: PromptSection = {
  name: "tool:agent_create",
  order: ORDER.tool + 138,
  requires: [TOOL_AGENT_CREATE],
  text:
    "- The sidebar can hold several counterparts, each with its own role and " +
    "conversation.\n  When the user describes another one they want, call " +
    "agent_create with a name\n  and the role in their words — do not ask " +
    "them for those facts again in the tool;\n  it cannot talk back. The new " +
    "agent appears in the sidebar, and this conversation\n  stays as it is.",
};

const TASK_SECTION: PromptSection = {
  name: "tool:task",
  order: ORDER.tool + 130,
  requires: [TOOL_TASK],
  text: "- Delegate independent work to sub-agents with the task tool and " +
    "keep working\n  while they run: wait for one with task_output (wait: " +
    "true) when your next step\n  depends on its result, and reach a running " +
    "agent with send_message.",
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
    "user: acknowledge\n  it and carry on — never treat it as user input. Do " +
    "not poll a running background\n  command: its notification arrives on " +
    "its own.",
};

// --- quality and workflow ----------------------------------------------------

const QUALITY_SECTION: PromptSection = {
  name: "quality",
  order: ORDER.quality,
  text: "- Prioritize correctness above all else.\n" +
    "- Never fabricate tool or test results.\n" +
    "- Do not silently narrow the requested scope.\n" +
    "- Do not ask the user for information you can obtain from your tools.\n" +
    "- After making changes, verify them (run tests, builds) when " +
    "appropriate.\n" +
    "- Write code with future maintainers in mind.\n" +
    "- Avoid unnecessary allocations and computation.\n" +
    "- Never discard changes the user has already made.",
};

const WORKFLOW_SECTION: PromptSection = {
  name: "workflow",
  order: ORDER.workflow,
  text: "- For multi-file changes, plan before editing, investigate existing " +
    "patterns\n  before implementing, and fix root causes rather than " +
    "symptoms. Do a clean\n  cutover: leave no old callers or compatibility " +
    "shims behind.\n" +
    "- Do not stop halfway: carry the work through until the deliverable is\n" +
    "  complete.\n" +
    "- Do not hand in TODOs or placeholder implementations as finished work.\n" +
    "- Finish by saying what you did and how you verified it, and report " +
    "only\n  what this session's tool results establish — say so when " +
    "something could\n  not be checked.",
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
  requires: [TOOL_READ, TOOL_GREP, TOOL_GLOB, TOOL_LIST_DIR],
  text: "- You are read-only: investigate with read/grep/glob/list_dir/skill " +
    "and report\n  findings with file references (path:line). Never modify " +
    "files or run commands.",
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
  GLOB_SECTION,
  GREP_SECTION,
  SEARCH_CAPS_SECTION,
  BASH_SECTION,
  ASYNC_BASH_SECTION,
  EVAL_SECTION,
  ASK_SECTION,
  TODO_SECTION,
  SKILL_SECTION,
  VISUAL_DIAGRAM_SECTION,
  VISUAL_IMAGE_SECTION,
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
 * file/shell sections apply exactly as they do in a workspace. */
export const STELLA_PROMPT_SECTIONS: readonly PromptSection[] = [
  READ_SECTION,
  WRITE_SECTION,
  EDIT_SECTION,
  GLOB_SECTION,
  GREP_SECTION,
  SEARCH_CAPS_SECTION,
  BASH_SECTION,
  ASYNC_BASH_SECTION,
  ASK_SECTION,
  TODO_SECTION,
  SKILL_SECTION,
  VM_SCREENSHOT_SECTION,
  VM_ACT_SECTION,
  HISTORY_SEARCH_SECTION,
  AGENT_CREATE_SECTION,
  VISUAL_IMAGE_SECTION,
  TASK_SECTION,
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
