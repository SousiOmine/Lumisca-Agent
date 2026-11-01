import type {
  AskAnswer,
  PendingFile,
  PendingImage,
  StellaConversationSnapshot,
  StellaEvent,
} from "./types.ts";
import { promptBody, request } from "./api-client.ts";
import { openEventStream } from "./event-stream.ts";

/**
 * The stella conversation API: one surface of its own, bound to an agent.
 *
 * The conversation has its own endpoints and its own event stream
 * (`/api/stella/conversations/:agentId/…`) rather than borrowing the
 * session-scoped ones: what a conversation shows is a different thing from
 * what a code-mode session shows (no tool rows, no panels, no context
 * publications), and the server is the one deciding that — a client never
 * receives the model's rows at all. Addressing it by agent is the same
 * statement in the URL: stella has no session concept, so a client cannot
 * accidentally treat one as a tab.
 */

/** Path of one conversation's endpoint. */
function conversationPath(agentId: string, suffix = ""): string {
  return `/api/stella/conversations/${encodeURIComponent(agentId)}${suffix}`;
}

export const stellaApi = {
  /** Open the conversation (created on first use; this starts the machine)
   * and read its snapshot. */
  open: (agentId: string) =>
    request<StellaConversationSnapshot>(conversationPath(agentId), {
      method: "GET",
    }),

  /** Re-read the snapshot after a WS drop or a page reload, or read the
   * window before a cursor (see StellaConversationSnapshot.older). */
  getSnapshot: (agentId: string, window: { older?: string } = {}) => {
    const query = window.older === undefined
      ? ""
      : `?older=${encodeURIComponent(window.older)}`;
    return request<StellaConversationSnapshot>(
      conversationPath(agentId, `/messages${query}`),
      { method: "GET" },
    );
  },

  /** The conversation's revision: a cheap counter to poll so the snapshot is
   * re-read only when something was missed. */
  getRevision: (agentId: string) =>
    request<{ rev: number }>(conversationPath(agentId, "/revision"), {
      method: "GET",
    }),

  /** Send a prompt into the conversation. The body is the same one code
   * mode's session prompt takes (`promptBody`): text plus the images the
   * user attached, so a drag-and-drop or a paste means the same thing in
   * both modes. */
  prompt: (
    agentId: string,
    text: string,
    images?: PendingImage[],
    files?: PendingFile[],
  ) =>
    request<{ ok: true }>(conversationPath(agentId, "/prompt"), {
      method: "POST",
      body: JSON.stringify(promptBody(text, images, undefined, files)),
    }),

  abort: (agentId: string) =>
    request<{ ok: true }>(conversationPath(agentId, "/abort"), {
      method: "POST",
    }),

  answer: (agentId: string, toolCallId: string, answers: AskAnswer[]) =>
    request<{ ok: true }>(conversationPath(agentId, "/answer"), {
      method: "POST",
      body: JSON.stringify({ toolCallId, answers }),
    }),

  /** The user finished at the screen (`vm_ask_user`). */
  finishHandover: (agentId: string, note: string, toolCallId: string) =>
    request<{ ok: true }>(conversationPath(agentId, "/handover"), {
      method: "POST",
      body: JSON.stringify({ note, toolCallId }),
    }),

  /** Rewind from a message onward (named by its timestamp). */
  rewind: (agentId: string, timestamp: number) =>
    request<{ ok: true }>(conversationPath(agentId, "/rewind"), {
      method: "POST",
      body: JSON.stringify({ timestamp }),
    }),
};

/** Connect to one conversation's event stream. Returns a close function.
 *
 * The contract is the shared one (see event-stream.ts: heartbeat watchdog,
 * re-sync on reconnect); only the path and the frame type differ. The frames
 * are `StellaEvent`s — the conversation's events — with no session id and
 * none of the model's traffic. */
export function connectStellaEvents(
  agentId: string,
  onEvent: (event: StellaEvent) => void,
  onClose: () => void,
  onOpen?: () => void,
): () => void {
  return openEventStream(
    { path: conversationPath(agentId, "/events") },
    onEvent,
    onClose,
    onOpen,
  );
}
