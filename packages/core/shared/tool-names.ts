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
 * BrowserBackend is available — Desktop and CLI). */
export const TOOL_BROWSER_OPEN = "browser_open";
export const TOOL_BROWSER_OBSERVE = "browser_observe";
export const TOOL_BROWSER_ACT = "browser_act";
export const TOOL_BROWSER_WAIT = "browser_wait";
export const TOOL_BROWSER_SCREENSHOT = "browser_screenshot";
export const TOOL_BROWSER_CLOSE = "browser_close";
