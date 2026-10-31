/**
 * The application's operating mode: whose world the UI shows.
 *
 * The choice belongs to the VIEW, not to the server: two clients (the
 * desktop window and a browser, or two browsers) show the same server in
 * whichever mode each of them picked, and switching in one must never reach
 * into the other. It therefore lives in the client's own storage
 * (web/src/hooks/useAppMode.ts) and never in the settings table.
 */

/** The modes. `code` is the coding agent (workspaces, sessions, tabs);
 * `stella` is the single ongoing conversation inside a virtual machine. */
export const APP_MODES = ["code", "stella"] as const;

export type AppMode = (typeof APP_MODES)[number];

export function isAppMode(value: unknown): value is AppMode {
  return typeof value === "string" &&
    (APP_MODES as readonly string[]).includes(value);
}
