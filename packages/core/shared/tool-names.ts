/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db, no Node APIs), bundled into the browser client. */

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
/** Search the web / read a page through the user's own search provider.
 * Preloaded (not discoverable) for every session whose user configured a
 * provider: a session without one never sees them, so the model is never
 * told about a tool that would fail. */
export const TOOL_WEB_SEARCH = "web_search";
export const TOOL_WEB_FETCH = "web_fetch";

/** Publish an image file so it can be shown inside the agent's reply (the
 * `visual:` image references). Coding sessions only: a chat session has no
 * workspace to publish from. */
export const TOOL_VISUAL = "visual";

/** The stella machine's screen (a stella session's only display). Preloaded
 * rather than discoverable: without it an agent would never know it can look
 * at — or click on — the machine it works in. */
export const TOOL_VM_SCREENSHOT = "vm_screenshot";
export const TOOL_VM_ACT = "vm_act";
/** The machine's widgets, by role and name, through the accessibility tree
 * (`vm_find` / `vm_do` / `vm_wait`). Preloaded for the same reason as the
 * screen tools: an agent that does not know it can address a button by name
 * will read coordinates off a picture for everything. */
export const TOOL_VM_FIND = "vm_find";
export const TOOL_VM_DO = "vm_do";
export const TOOL_VM_WAIT = "vm_wait";
/** Start a GUI program in the machine (`vm_launch`), and list the ones
 * installed. Preloaded for the same reason as the screen tools: an agent that
 * cannot see what is installed starts a program it assumes exists. */
export const TOOL_VM_LAUNCH = "vm_launch";
/** Hand the machine's screen to the user and wait (`vm_ask_user`). Preloaded
 * for the same reason as the screen tools: an agent must know that asking a
 * person is an option, or it will try to type the password itself. */
export const TOOL_VM_ASK_USER = "vm_ask_user";
/** Ask the user for the value of an environment variable (`vm_env`) — the
 * value is stored in the machine and never returned to the model.
 * Discoverable rather than preloaded (a conversation that never needs a
 * secret pays nothing), and main-only: the saved value belongs to the
 * machine, not to one agent's run. The built-in `vm-env` skill is what tells
 * the agent the tool exists. */
export const TOOL_VM_ENV = "vm_env";

/** Move one file between the machine and a folder lent from the user's own
 * computer, byte for byte (`share_upload` / `share_download`). Discovered
 * through tool_search: a conversation that lends nothing has no use for
 * them, and without them the model would read a picture as text and write
 * back something that is no longer the file. */
export const TOOL_SHARE_UPLOAD = "share_upload";
export const TOOL_SHARE_DOWNLOAD = "share_download";

/** Ask the user to lend a folder from their computer (`share_request`) and
 * withdraw one again (`share_disconnect`). Both are discovered rather than
 * preloaded — a conversation that lends nothing pays nothing for their
 * definitions — and both belong to the conversation's main agent, which is
 * the only one that may put a question to the user or end a loan the run is
 * working in. The built-in `folder-share` skill is what tells the agent they
 * exist. */
export const TOOL_SHARE_REQUEST = "share_request";
export const TOOL_SHARE_DISCONNECT = "share_disconnect";

/** Send files to the user (images inline, everything else as a download).
 * Code mode only: there the reply's own text is what the user reads, so this
 * tool attaches what they should look at or keep. Preloaded wherever the
 * session has a file backend to read from, because an agent that cannot see
 * the tool rats out paths in prose instead of handing the file over. */
export const TOOL_CHAT_ATTACH = "chat_attach";

/** Send something beside the reply: a card, files, and/or progress text in
 * one call. The final text of a stella turn is already the agent's reply
 * (see agent/stella-stream.ts), so this tool carries what a reply cannot — a
 * card, a file, or a few words while a longer turn is still running. A turn
 * with nothing to add writes NO_RESPONSE. Preloaded: an agent that does not
 * know it can send a card or a file never does. */
export const TOOL_SEND_CHAT = "send_chat";

/** Create another stella agent (a separate agent with its own name, role and
 * conversation). Terasuma's `tera_create`. */
export const TOOL_AGENT_CREATE = "agent_create";

/** Run a scheduled request in this conversation (`routine_*`). Discoverable
 * rather than preloaded: a routine is created once and then runs on its own,
 * so its five tool definitions would cost every turn for no gain. */
export const TOOL_ROUTINE_CREATE = "routine_create";
export const TOOL_ROUTINE_LIST = "routine_list";
export const TOOL_ROUTINE_UPDATE = "routine_update";
export const TOOL_ROUTINE_DELETE = "routine_delete";
export const TOOL_ROUTINE_RUN = "routine_run";

/** Manage the app-level MCP server config (`mcp_add` / `mcp_remove` /
 * `mcp_list`) — the list Settings → MCP servers shows, which every
 * workspace and every session uses. Discoverable rather than preloaded (a
 * conversation that never touches the config pays nothing for them), and
 * main-only: the config outlives a sub-agent's run. */
export const TOOL_MCP_ADD = "mcp_add";
export const TOOL_MCP_REMOVE = "mcp_remove";
export const TOOL_MCP_LIST = "mcp_list";

/** Search this conversation's saved history, including the turns a
 * compaction checkpoint replaced (so they are no longer in the model's
 * context). Preloaded: a session that was condensed needs to know it can
 * look back, and the tool costs one short definition. */
export const TOOL_HISTORY_SEARCH = "history_search";

/** Read and rewrite the agent's own description of itself (its identity,
 * separate from the role the user wrote). Preloaded: an agent that cannot
 * write about itself never does, and a write is published as a context
 * message rather than by editing the system prompt (see
 * stella/identity.ts). */
export const TOOL_IDENTITY = "identity";
