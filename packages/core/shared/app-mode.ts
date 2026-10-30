/**
 * The application's operating mode: whose world the UI shows.
 *
 * The choice lives on the server (a setting — see settings-keys.ts) because
 * it decides how the page is framed and which session the client talks to.
 * It is deliberately not per-tab or per-URL: a machine runs one of the two,
 * and switching is a deliberate act from the app menu, not a thing that
 * happens by opening another tab.
 */

/** The modes. `code` is the coding agent (workspaces, sessions, tabs);
 * `stella` is the single ongoing conversation inside a virtual machine. */
export const APP_MODES = ["code", "stella"] as const;

export type AppMode = (typeof APP_MODES)[number];

export function isAppMode(value: unknown): value is AppMode {
  return typeof value === "string" &&
    (APP_MODES as readonly string[]).includes(value);
}
