/**
 * Every action the desktop bridge answers, in one list.
 *
 * The shell has three readers: the page's `shellCall`, the splash's plain
 * `fetch`, and the Rust match that implements them. The names used to be
 * spelled in all three with nothing comparing them, so an action the page
 * called could be missing from the match (a 404 the UI reports as a generic
 * failure) or a Rust arm could be dead. The Rust test reads this list with
 * include_str! and compares it with the match; the web test compares the
 * splash's URLs with it.
 */
export const SHELL_ACTIONS = [
  "state",
  // The servers this window can display (the shell's own registry).
  "connections/list",
  "connections/get",
  "connections/save",
  "connections/delete",
  "connect-remote",
  "connect-local",
  "connect-saved",
  // Folder loans from this computer.
  "share/pick-folder",
  "share/grant",
  "share/revoke",
  // The whole computer as one loan, and the way to withdraw it at once.
  "share/grant-computer",
  "share/revoke-group",
  // How long a loan survives without use (Settings → アプリ).
  "share/idle",
  "share/set-idle",
  // Local server diagnostics.
  "server/status",
  "server/restart",
  // Links the page cannot open itself (MCP sign-in).
  "open-url",
  // Reachability check from the settings form.
  "test",
  // Auto-update.
  "update/status",
  "update/set-auto",
  "update/check",
  "update/download",
  "update/install",
  // Custom title bar.
  "window/minimize",
  "window/toggle-maximize",
  "window/close",
  "window/start-drag",
  "window/state",
  "window/focus",
  // The OS folder picker (a local workspace folder).
  "pick-folder",
  // One file the displayed server serves, saved where the user picks.
  "save-file",
  // Background agent-event notification.
  "notify",
  "quit",
] as const;

export type ShellAction = (typeof SHELL_ACTIONS)[number];
