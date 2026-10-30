import type {
  AskAnswer,
  StellaConversationSnapshot,
  StellaEvent,
} from "./types.ts";
import { WS_HEARTBEAT_TYPE } from "@lumisca/core/shared";
import { createHeartbeatWatchdog } from "./heartbeat.ts";
import { request, token } from "./api-client.ts";

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

  /** Re-read the snapshot after a WS drop or a page reload. */
  getSnapshot: (agentId: string) =>
    request<StellaConversationSnapshot>(
      conversationPath(agentId, "/messages"),
      { method: "GET" },
    ),

  /** The conversation's revision: a cheap counter to poll so the snapshot is
   * re-read only when something was missed. */
  getRevision: (agentId: string) =>
    request<{ rev: number }>(conversationPath(agentId, "/revision"), {
      method: "GET",
    }),

  prompt: (agentId: string, text: string) =>
    request<{ ok: true }>(conversationPath(agentId, "/prompt"), {
      method: "POST",
      body: JSON.stringify({ text }),
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
 * The contract mirrors connectEvents (heartbeat watchdog, re-sync on
 * reconnect), and differs in only one way: the frames are `StellaEvent`s —
 * the conversation's events — with no session id and none of the model's
 * traffic. */
export function connectStellaEvents(
  agentId: string,
  onEvent: (event: StellaEvent) => void,
  onClose: () => void,
  onOpen?: () => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(
    `${proto}//${location.host}${
      conversationPath(agentId, "/events")
    }${suffix}`,
  );
  let closed = false;
  const watchdog = createHeartbeatWatchdog({
    onDead: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  });
  const onVisibility = () => {
    if (!document.hidden) watchdog.check();
  };
  document.addEventListener("visibilitychange", onVisibility);

  ws.onopen = () => {
    watchdog.beat();
    onOpen?.();
  };
  ws.onmessage = (e) => {
    watchdog.beat();
    try {
      const parsed = JSON.parse(String(e.data)) as { type?: string };
      if (parsed?.type === WS_HEARTBEAT_TYPE) return;
      onEvent(parsed as StellaEvent);
    } catch {
      // ignore malformed messages
    }
  };
  ws.onclose = () => {
    watchdog.stop();
    if (!closed) onClose();
  };

  return () => {
    closed = true;
    watchdog.stop();
    document.removeEventListener("visibilitychange", onVisibility);
    ws.close();
  };
}
