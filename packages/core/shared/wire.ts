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
 * Frontend-safe (no Bun APIs, no `node:`): the web bundle imports this through
 * `@lumisca/core/shared`.
 */
import type { AgentMessage } from "../domain/message.ts";

import type { BackgroundCommandInfo } from "../tools/background.ts";
import type { ContextUsageSummary } from "./context-usage.ts";
import type { AskQuestion, TaskInfo, TodoPhase } from "./interaction.ts";

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

/** What one client reads about stella mode as a whole
 * (`GET /api/stella/status`). The CHOSEN mode is deliberately not part of it:
 * that belongs to each client (see app-mode.ts), so a window switching modes
 * never drags a browser showing the same server along with it. */
export interface StellaStatus {
  /** Whether stella can run on the server this client talks to, with the
   * reason when it cannot. */
  availability: StellaAvailability;
  /** True while the installation is being prepared: a first run builds the
   * image, which takes minutes, and a machine is being started. The one wait
   * the UI shows. */
  starting: boolean;
  /** Why the installation is in this state, when it has something to say. */
  reason: string;
}

/** What one client reads about one agent's machine
 * (`GET /api/stella/agents/:agentId/machine`).
 *
 * Each agent has its own container, and it may be asleep while its neighbours
 * work: the state is what the screen pane draws ("running", "asleep",
 * "starting") and what makes a wake button appear. */
export interface StellaMachineStatus {
  /** `running`, `stopped` (asleep), `container_missing`, `image_missing`,
   * `image_stale`, `podman_missing`, `podman_unusable`. */
  state: string;
  /** True while this machine is being started. */
  starting: boolean;
  /** Why it is in this state, when the state has something to say. */
  reason: string;
}

// --- a code-mode session's snapshot (server/routes/sessions.ts ↔ web) --------

/** One ask still waiting for the user's answers, as a snapshot carries it:
 * the tool call that asked, and its questions. (The core's own
 * `PendingQuestion` in tools/ask.ts is the same pair, but that module holds
 * the hub, which is backend-only; a wire shape cannot live there.) */
export interface PendingQuestionLike {
  toolCallId: string;
  questions: AskQuestion[];
}

/** What `GET /api/sessions/:id/messages` answers: the run's state and the
 * transcript window, read in one handler so they describe the same instant.
 *
 * It lives here rather than in the web package because BOTH sides need it: a
 * field renamed on the server only failed at run time while the shape was
 * declared twice (and the client's copy stayed "required" after the server
 * stopped sending it). stella's conversation snapshot is the same kind of
 * shape and lives in the core's types for the same reason. */
export interface SessionSnapshot {
  /** A WINDOW of the transcript, oldest first: the newest messages on open,
   * or the ones before the `older` cursor a client asked for. */
  messages: AgentMessage[];
  /** The cursor for the window before `messages[0]`, or null at the
   * transcript's beginning. Opaque; echo it back to read further. */
  older: string | null;
  /** A run is active right now (its `agent_start` was never replayed). */
  running: boolean;
  /** Questions the agent is waiting on (the ask tool); empty when none is
   * pending. The run stays blocked until they are answered. */
  questions: PendingQuestionLike[];
  /** The session's panel snapshots, read in the same handler: a resync then
   * needs one request per tab instead of four. */
  todos: TodoPhase[];
  tasks: TaskInfo[];
  backgrounds: BackgroundCommandInfo[];
  /** The last run failure, if any (cleared when a new run starts). Absent
   * when the session has not failed. */
  error?: string;
  /** The session's current title (it may have been generated after the
   * client last read the session info). */
  name: string;
  /** Context usage over the WHOLE transcript. A window cannot answer this
   * (its older turns are not loaded), and the meter would silently report
   * the window's average as the session's. */
  usage: ContextUsageSummary;
  /** The session's revision at the moment of this snapshot: the client seeds
   * its "everything seen up to here" marker from it, so a later probe can
   * tell whether anything was missed. */
  rev: number;
}
