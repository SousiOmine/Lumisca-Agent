/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / pi imports), bundled into the browser client. */

/** Tool names of the built-in coding tools. Single source of truth shared
 * with the UI, so the tool registry can never drift from the
 * implementations (tool names are part of the agent-visible contract). */
export const TOOL_READ = "read";
export const TOOL_WRITE = "write";
export const TOOL_EDIT = "edit";
export const TOOL_LIST_DIR = "list_dir";
export const TOOL_BASH = "bash";
export const TOOL_ASYNC_BASH = "async_bash";
export const TOOL_ASYNC_BASH_STATUS = "async_bash_status";
export const TOOL_ASYNC_BASH_KILL = "async_bash_kill";
export const TOOL_GREP = "grep";
export const TOOL_GLOB = "glob";
export const TOOL_SKILL = "skill";
export const TOOL_EVAL = "eval";
export const TOOL_ASK = "ask";
export const TOOL_TODO = "todo";
export const TOOL_TASK = "task";
export const TOOL_TASK_OUTPUT = "task_output";
export const TOOL_SEND_MESSAGE = "send_message";
/** Discover tools held in the session's tool registry (not preloaded into
 * the LLM context): search returns their names and argument summaries. */
export const TOOL_SEARCH = "tool_search";
/** Execute a tool found through tool_search by name — the single dispatch
 * point for tools whose definitions stay out of the LLM context. */
export const TOOL_CALL = "tool_call";
/** Browser-lab tools (the built-in WebView debugger; present only when a
 * BrowserBackend is available — the desktop shell). */
export const TOOL_BROWSER_OPEN = "browser_open";
export const TOOL_BROWSER_OBSERVE = "browser_observe";
export const TOOL_BROWSER_ACT = "browser_act";
export const TOOL_BROWSER_WAIT = "browser_wait";
export const TOOL_BROWSER_SCREENSHOT = "browser_screenshot";
export const TOOL_BROWSER_CLOSE = "browser_close";
/** Computer-use tools (the machine's screen, mouse and keyboard; present
 * only when a computer host is attached AND the user enabled the feature —
 * discoverable via tool_search, never preloaded, the same contract as MCP,
 * browser-lab and PDF tools). */
export const TOOL_COMPUTER_SCREENSHOT = "computer_screenshot";
export const TOOL_COMPUTER_ACT = "computer_act";
export const TOOL_COMPUTER_LIST_WINDOWS = "computer_list_windows";
/** PDF page-as-image tool (renders workspace PDF pages to PNG images for
 * vision models; discoverable via tool_search, never preloaded — the same
 * contract as MCP and browser-lab tools). */
export const TOOL_PDF_READ_PAGES = "pdf_read_pages";
/** Publish an image file so it can be shown inside the agent's reply (the
 * `visual:` image references). Coding sessions only: a chat session has no
 * workspace to publish from. */
export const TOOL_VISUAL = "visual";

/** The stella machine's screen (a stella session's only display). Preloaded
 * rather than discoverable: without it an agent would never know it can look
 * at — or click on — the machine it works in. */
export const TOOL_VM_SCREENSHOT = "vm_screenshot";
export const TOOL_VM_ACT = "vm_act";
/** Hand the machine's screen to the user and wait (`vm_ask_user`). Preloaded
 * for the same reason as the screen tools: an agent must know that asking a
 * person is an option, or it will try to type the password itself. */
export const TOOL_VM_ASK_USER = "vm_ask_user";

/** Show a card in the chat (text, list, table, flow, choice, form). The card
 * carries its own blocks; a Choice or Form click comes back as the user's
 * next message, not as a tool result. Preloaded: the model must know it can
 * ask with a card instead of a wall of prose. */
export const TOOL_CHAT_UI = "chat_ui";

/** Create another stella agent (a separate counterpart with its own name, role
 * and conversation). Terasuma's `tera_create`. */
export const TOOL_AGENT_CREATE = "agent_create";

/** Run a scheduled request in this conversation (`routine_*`). Discoverable
 * rather than preloaded: a routine is created once and then runs on its own,
 * so its five tool definitions would cost every turn for no gain. */
export const TOOL_ROUTINE_CREATE = "routine_create";
export const TOOL_ROUTINE_LIST = "routine_list";
export const TOOL_ROUTINE_UPDATE = "routine_update";
export const TOOL_ROUTINE_DELETE = "routine_delete";
export const TOOL_ROUTINE_RUN = "routine_run";

/** Search this conversation's saved history, including the turns a
 * compaction checkpoint replaced (so they are no longer in the model's
 * context). Preloaded: a session that was condensed needs to know it can
 * look back, and the tool costs one short definition. */
export const TOOL_HISTORY_SEARCH = "history_search";
