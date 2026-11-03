import type { AgentMessage } from "../ai/types.ts";
import type { MessageIdentity } from "../types/event.ts";

/**
 * Reading a transcript one window at a time.
 *
 * A session's transcript is the model's whole history and grows without
 * bound, but a client draws only what fits on its screen and reads back no
 * further than the reader scrolls. Sending all of it on every (re)connect,
 * tab restore and page load is what made a long conversation slow to open and
 * slow to keep in sync, so the snapshot endpoints serve one window and hand
 * back a cursor for the next older one (Terasuma's API has the same shape).
 *
 * Two rules live here.
 *
 * **The cursor is an identity, not a position.** It names the oldest item a
 * client holds (role + timestamp, plus the tool call id for a tool result),
 * and the server resolves it against the live transcript. Positions would
 * have been simpler but not stable: compaction inserts a checkpoint into the
 * middle of the transcript, shifting every later index by one, so a client
 * paging by index would silently skip a message or repeat one. Identities
 * survive insertions and suffix deletions (a rewind), and the cursor stays
 * opaque — a client only ever echoes it.
 *
 * **A message window starts at a turn.** The transcript's renderer groups
 * messages into turns beginning at a prompt, a mode prompt, a notification or
 * a compaction checkpoint; a window that began in the middle would hand it
 * assistant and tool rows whose prompt it does not have, which it can neither
 * draw as a turn nor rewind. The start therefore moves back to the nearest
 * turn beginning, so one long turn can make a window larger than the page
 * size — half a turn is not a useful screen.
 */

/** Items one read returns when the caller names no count. */
export const TRANSCRIPT_WINDOW_ITEMS = 40;

/** Most items one read returns: a client-sized window must not be able to
 * ask for the whole transcript again. */
export const MAX_TRANSCRIPT_WINDOW_ITEMS = 200;

/** What a client asks for: the newest window, or the window before the item
 * its `older` cursor names. */
export interface WindowQuery {
  /** The cursor of the next older window (null/absent → the newest one). */
  older?: string | null;
  /** How many items to return. */
  limit?: number;
}

/** One window of a transcript, with the way back. */
export interface WindowPage<T> {
  /** Oldest first, as the transcript holds them. */
  items: T[];
  /** The cursor for the next older window, or null at the transcript's
   * beginning. Clients echo it back to read further. */
  older: string | null;
}

/**
 * The identity of one transcript message, as clients tell two apart (see the
 * web's `messageKey`). Two roles need a field beyond role + timestamp,
 * because a millisecond is not unique:
 *
 * - a tool result is identified by its tool call id (parallel calls finish
 *   together),
 * - a context snapshot by its provider (the dynamic contexts are published
 *   in one loop and share the millisecond).
 */
export function messageIdentityOf(message: AgentMessage): MessageIdentity {
  switch (message.role) {
    case "toolResult":
      return {
        role: message.role,
        timestamp: message.timestamp,
        toolCallId: message.toolCallId,
      };
    case "context":
      return {
        role: message.role,
        timestamp: message.timestamp,
        provider: message.provider,
      };
    default:
      return { role: message.role, timestamp: message.timestamp };
  }
}

/** The cursor naming one message. */
export function messageCursorOf(message: AgentMessage): string {
  return identityCursor(messageIdentityOf(message));
}

/** The cursor of one identity: its fields as JSON. Opaque to clients, so the
 * shape is free to change here. */
export function identityCursor(identity: MessageIdentity): string {
  return JSON.stringify([
    identity.role,
    identity.timestamp,
    identity.toolCallId ?? "",
    identity.provider ?? "",
  ]);
}

/**
 * Whether the message begins a turn in the client's transcript view (see the
 * web's buildTurns): a prompt, a mode prompt (`/plan`), a system notification
 * that started its own run, or a compaction checkpoint (a row of its own).
 * Every other role belongs to the turn before it.
 *
 * A retry notification is NOT one. It is the loop's own repair of a response
 * that was empty or cut off, and the renderer drops it rather than drawing a
 * row for it (see the web's buildTurns). Counting it here made the server
 * open a window on a row the client discards — and a window that begins with
 * a row the client does not draw has no turn to show at all, so the screen
 * stayed empty. The two rules are the same rule, and this is the one place
 * both read it.
 */
export function startsTranscriptTurn(message: AgentMessage): boolean {
  if (message.role === "notification") return message.kind !== "retry";
  return message.role === "user" || message.role === "mode" ||
    message.role === "checkpoint";
}
