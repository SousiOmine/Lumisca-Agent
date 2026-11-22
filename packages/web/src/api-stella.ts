import { paths } from "@lumisca/core/shared";
import { apiPathOf, promptBody, request } from "./api-client.ts";
import { openEventStream } from "./event-stream.ts";
import type {
  AskAnswer,
  PendingFile,
  PendingImage,
  StellaConversationSnapshot,
  StellaEvent,
} from "./types.ts";

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

/** Path of one conversation's endpoint, from the shared templates: the same
 * strings the server registers (core/shared/api-paths.ts). */
function conversationPath(
  template: string,
  agentId: string,
  suffix = "",
): string {
  return `/api${apiPathOf(template, {
    agentId: encodeURIComponent(agentId),
  })}${suffix}`;
}

export const stellaApi = {
  /** Open the conversation (created on first use; this starts the machine)
   * and read its snapshot. */
  open: (agentId: string) =>
    request<StellaConversationSnapshot>(
      conversationPath(paths.conversation, agentId),
      {
        method: "GET",
      },
    ),

  /** Re-read the snapshot after a WS drop or a page reload, or read the
   * window before a cursor (see StellaConversationSnapshot.older). */
  getSnapshot: (agentId: string, window: { older?: string } = {}) => {
    const query =
      window.older === undefined
        ? ""
        : `?older=${encodeURIComponent(window.older)}`;
    return request<StellaConversationSnapshot>(
      conversationPath(paths.conversationMessages, agentId, query),
      { method: "GET" },
    );
  },

  /** The conversation's revision: a cheap counter to poll so the snapshot is
   * re-read only when something was missed. */
  getRevision: (agentId: string) =>
    request<{ rev: number }>(
      conversationPath(paths.conversationRevision, agentId),
      {
        method: "GET",
      },
    ),

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
    request<{ ok: true }>(conversationPath(paths.conversationPrompt, agentId), {
      method: "POST",
      body: JSON.stringify(promptBody(text, images, undefined, files)),
    }),

  abort: (agentId: string) =>
    request<{ ok: true }>(conversationPath(paths.conversationAbort, agentId), {
      method: "POST",
    }),

  answer: (agentId: string, toolCallId: string, answers: AskAnswer[]) =>
    request<{ ok: true }>(conversationPath(paths.conversationAnswer, agentId), {
      method: "POST",
      body: JSON.stringify({ toolCallId, answers }),
    }),

  /** The user finished at the screen (`vm_ask_user`). */
  finishHandover: (agentId: string, note: string, toolCallId: string) =>
    request<{ ok: true }>(
      conversationPath(paths.conversationHandover, agentId),
      {
        method: "POST",
        body: JSON.stringify({ note, toolCallId }),
      },
    ),

  /** The user entered the value of the environment variable the run is
   * waiting on (`vm_env`). The value goes into the machine; the server does
   * not echo it anywhere, and nothing here keeps it. */
  provideEnv: (agentId: string, value: string, toolCallId: string) =>
    request<{ ok: true }>(conversationPath(paths.conversationEnv, agentId), {
      method: "POST",
      body: JSON.stringify({ value, toolCallId }),
    }),

  /** The user refused to enter a value (`vm_env`): the run continues
   * without it. */
  declineEnv: (agentId: string, toolCallId: string) =>
    request<{ ok: true }>(
      conversationPath(paths.conversationEnvDecline, agentId),
      {
        method: "POST",
        body: JSON.stringify({ toolCallId }),
      },
    ),

  /** The user lent a folder (`share_request`): the blocked run continues.
   * The folder itself is not posted — the server's own list of loans is what
   * the tool reads. */
  lendShare: (agentId: string, toolCallId: string) =>
    request<{ ok: true }>(
      conversationPath(paths.conversationShareLend, agentId),
      {
        method: "POST",
        body: JSON.stringify({ toolCallId }),
      },
    ),

  /** The user refused to lend a folder: the run continues without one. */
  declineShare: (agentId: string, toolCallId: string) =>
    request<{ ok: true }>(
      conversationPath(paths.conversationShareDecline, agentId),
      {
        method: "POST",
        body: JSON.stringify({ toolCallId }),
      },
    ),

  /** The desktop app withdrew a loan (`share_disconnect`), or could not and
   * said why. The reason is handed to the blocked tool as it was given. */
  finishShareDisconnect: (
    agentId: string,
    toolCallId: string,
    ok: boolean,
    error?: string,
  ) =>
    request<{ ok: true }>(
      conversationPath(paths.conversationShareDisconnect, agentId),
      {
        method: "POST",
        body: JSON.stringify({
          toolCallId,
          ok,
          ...(error === undefined ? {} : { error }),
        }),
      },
    ),

  /** The text on the machine's clipboard (empty when nothing was copied
   * there). The screen pane reads it while the user drives the screen; the
   * VNC connection cannot carry the text (see core/vm/clipboard.ts). */
  readClipboard: (agentId: string) =>
    request<{ text: string }>(
      conversationPath(paths.conversationClipboard, agentId),
      {
        method: "GET",
      },
    ),

  /** Put text on the machine's clipboard, for the application the user is
   * about to paste into. Only the hand-over accepts it. */
  writeClipboard: (agentId: string, text: string) =>
    request<{ ok: true }>(
      conversationPath(paths.conversationClipboard, agentId),
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    ),

  /** Rewind from a message onward (named by its timestamp). */
  rewind: (agentId: string, timestamp: number) =>
    request<{ ok: true }>(conversationPath(paths.conversationRewind, agentId), {
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
    { path: conversationPath(paths.conversationEvents, agentId) },
    onEvent,
    onClose,
    onOpen,
  );
}
