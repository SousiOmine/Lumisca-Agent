/**
 * The folders a user lends to an agent from their own computer.
 *
 * A lent folder is not a workspace: it lives on a DIFFERENT machine from the
 * one the session works on (`/lend/<name>` in the agent's namespace, see
 * share/grant.ts), and it exists only while the desktop app that lent it
 * keeps saying so. The type below is what both sides read: the desktop app
 * composes one per folder it lends, and the client draws the list it is
 * given (see ClientEvent's `shares`).
 */

/** The operating systems the desktop shell runs on. A lent folder's commands
 * run in that OS's shell, so the agent is told which one it got. */
export type SharePlatform = "macos" | "windows" | "linux";

/** The computer a folder was lent from. */
export interface ShareHostInfo {
  platform: SharePlatform;
  /** What to call the computer: its hostname when the client has one, else
   * the platform's name. Display only — nothing resolves paths with it. */
  name: string;
  /** The shell commands there run in, named for the model ("zsh",
   * "PowerShell 7"). Empty when the grant does not lend a shell. */
  shell: string;
}

/** One folder lent to a session, as the server and the UI see it. */
export interface FolderShare {
  /** Identifies the grant for the life of the lending app run. */
  id: string;
  /** The folder's name in the agent's namespace: `/lend/<name>`. Lowercase
   * letters, digits and dashes only — it is a path segment. */
  name: string;
  /** The folder on the user's computer, exactly as they chose it. Display
   * only: the server never turns this into a path it touches, and the wire
   * carries grant-relative segments instead (see share/ops.ts). */
  path: string;
  host: ShareHostInfo;
  /** Whether the agent may write there. False is enforced by the backend
   * (`writeText` / `removeFile`), not by the tools. */
  write: boolean;
  /** Whether commands may run there. False makes `bash` refuse a cwd inside
   * the folder instead of running the command somewhere else. */
  exec: boolean;
  /** Epoch ms after which the lender drops the grant on its own. */
  expiresAt: number;
}
