/**
 * The wire shapes this app defines itself, where both sides of one endpoint
 * need the same type.
 *
 * Most of what an endpoint answers is already a core type (a SessionInfo, a
 * ModelInfo). The shapes below were declared twice — once by the route that
 * produces them, once by the web module that reads them — and nothing made
 * the two agree: a field renamed on the server only failed at run time, and a
 * field the server stopped sending stayed in the client's type looking
 * required (see `boundaries_test.ts`, which checks imports, not shapes).
 *
 * Frontend-safe (no Deno, no `node:`): the web bundle imports this through
 * `@lumisca/core/shared`.
 */

// --- the folder picker (server/routes/fs.ts ↔ web/components/FolderBrowser) --

/** A place the folder picker's sidebar can start browsing from: an
 * OS-typical user folder, or a filesystem root (a drive on Windows). `kind`
 * is a token the UI translates — a root is labelled by its own path. */
export type FsPlaceKind =
  | "home"
  | "desktop"
  | "documents"
  | "downloads"
  | "root";

export interface FsPlace {
  kind: FsPlaceKind;
  path: string;
}

/** A browse entry. Folders can be entered (and picked as a workspace
 * folder); files are listed for orientation only. */
export interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

/** One step of the browser's address bar, from the filesystem root down to
 * the browsed folder. */
export interface FsBreadcrumb {
  name: string;
  path: string;
}

/** One directory listing (`GET /api/fs/browse`): the address bar's chain plus
 * the folder's entries, folders first. The server walks the chain because
 * only it knows the platform's path separators. */
export interface FsBrowse {
  path: string;
  /** The folder above this one, or null at a filesystem root. */
  parent: string | null;
  breadcrumbs: FsBreadcrumb[];
  entries: FsEntry[];
}

// --- federated peers (server/routes/federation.ts ↔ web/peers.ts) ------------

/** Reachability of one registered connection (`GET /api/fed/peers`), as the
 * session list uses it to label the rows of sessions that run elsewhere. */
export interface PeerStatus {
  id: string;
  name: string;
  /** The registered base URL (`scheme://host[:port]`). Kept beside the name
   * because the name is free text and may be empty: the URL's host is then
   * the only part of the entry the user recognises. */
  url: string;
  /** Whether the peer answered its health probe. */
  ok: boolean;
  /** Why the probe failed; absent when `ok` is true. */
  error?: string;
}

// --- stella's machine (server/routes/stella.ts ↔ web/hooks/useAppMode.ts) ----

/** Whether stella mode can run at all on a machine. `reason` is a full
 * sentence shown to the user: which prerequisite is missing and what to do
 * about it. The verdict itself is decided by vm/availability.ts from the
 * machine's status; the TYPE lives here because the client renders it. */
export type StellaAvailability =
  | { available: true }
  | { available: false; reason: string };

/** What one client reads about stella mode's machine
 * (`GET /api/stella/status`). The CHOSEN mode is deliberately not part of it:
 * that belongs to each client (see app-mode.ts), so a window switching modes
 * never drags a browser showing the same server along with it. */
export interface StellaStatus {
  /** Whether stella can run on the server this client talks to, with the
   * reason when it cannot. */
  availability: StellaAvailability;
  /** The machine's state (`running`, `stopped`, `image_missing`, ...). */
  state: string;
  /** The loopback port the screen is relayed on, null when the machine has
   * no screen to show (not running, or starting). */
  vncPort: number | null;
  /** Why the machine is in this state, when it has something to say. */
  reason: string;
  /** True while the machine is being prepared (a first run builds the image,
   * which takes minutes — the one wait the UI shows). */
  starting: boolean;
}
