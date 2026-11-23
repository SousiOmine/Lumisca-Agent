import { newestPreview } from "@lumisca/core/shared";
import { useEffect, useState } from "preact/hooks";
import type { StellaConversationState } from "../stella-state.ts";
import type {
  PendingFile,
  PendingImage,
  PromptUploader,
  StellaAgent,
  StellaAgentSummary,
} from "../types.ts";
import { useStellaAgents } from "./useStellaAgents.ts";
import { useStellaConversation } from "./useStellaConversation.ts";

/**
 * stella mode's state: the agents, which one the address names, and that
 * agent's conversation.
 *
 * Two hooks hold the halves (useStellaAgents and useStellaConversation), and
 * this one is where they meet: it passes the list's answer about whether the
 * agent on screen is switched off to the conversation, folds that
 * conversation's newest entry into its row, and holds the one failure line
 * both reads report on. Everything else belongs to one half.
 *
 * The conversation has its own endpoints and its own event stream (see
 * api-stella.ts), so this hook does not touch the tab views at all: a stella
 * conversation is not a session the App tracks (no tab, no session list, no
 * panels).
 *
 * WHICH conversation is open is not this hook's to decide: the address names
 * the agent (`/agents/<id>`), and choosing another is a navigation the App
 * makes. The hook reads the conversation the address names and drops it when
 * the address moves on.
 *
 * The machine is not part of this hook's API because it is not part of the
 * user's: the server starts it when the conversation is requested, and the one
 * consequence the client shows is `starting` on the status it already polls.
 */
export type StellaHook = {
  /** The sidebar's rows, newest message first (see compareAgentRows). */
  agents: StellaAgentSummary[];
  /** The first read of the agent list is in flight. The list is empty until
   * it lands, so without this the sidebar says "no agent yet" over a list
   * that is on its way — a line the reader reads and believes. */
  agentsLoading: boolean;
  /** The agent whose conversation the address names, or null on the list.
   * An input (the URL is where the choice lives), not something this hook
   * decides: switching agents is a navigation. */
  activeAgentId: string | null;
  /** The active agent's conversation, or null before it is open. */
  conversation: StellaConversationState | null;
  /** The conversation's session id (the key its published images are stored
   * under; the client addresses the conversation by agent). */
  sessionId: string | null;
  /** Send the composer's text with the attachments: `images` are shown
   * inline and passed to the model as content, `files` are written into the
   * machine and named in the text the model receives. */
  /** Send the prompt. Rejects when the server did not take it (the
   * conversation error is set as well); the composer restores the text. */
  prompt: (
    text: string,
    images?: PendingImage[],
    files?: PendingFile[],
  ) => Promise<void>;
  /** Start one attached file's transfer to this conversation's agent. The
   * composer calls it when the file is picked; the prompt then names the id
   * the transfer resolves with. */
  uploadFile: PromptUploader;
  abort: () => void;
  answer: (
    toolCallId: string,
    answers: { id: string; values: string[] }[],
  ) => Promise<void>;
  rewind: (timestamp: number) => Promise<void>;
  finishHandover: (note: string, toolCallId: string) => Promise<void>;
  /** Enter the value of the environment variable the run waits for
   * (`vm_env`). Rejects when the server did not take it (an expired
   * dialog); the dialog shows the failure and stays open. */
  provideEnv: (value: string, toolCallId: string) => Promise<void>;
  /** Refuse to enter a value: the run continues without it. */
  declineEnv: (toolCallId: string) => Promise<void>;
  /** The user lent a folder from the card `share_request` put in the
   * conversation: the blocked run continues. */
  lendShare: (toolCallId: string) => Promise<void>;
  /** The user refused to lend a folder: the run continues without one. */
  declineShare: (toolCallId: string) => Promise<void>;
  /** Read the entries before the loaded window (the reader reached the top
   * of the conversation). Returns whether a read started. */
  loadOlder: () => boolean;
  /** Whether that read is still in flight. */
  loadingOlder: boolean;
  /** Why the conversation could not be opened, or null. A failed prompt or
   * abort is NOT this: that failure leaves the conversation open and is shown
   * in the transcript (see prompt / abort), because replacing a whole
   * conversation with an error because one send failed loses the history the
   * user would retry from. */
  error: string | null;
  loading: boolean;
  /** Re-read the agent list (after a create / delete). */
  reloadAgents: () => void;
  /** Put one agent's row into the list as the server answered it — an edit
   * (a new name, picture or model) or a create — so the sidebar and the
   * header redraw without a full re-read of the list. A row the list does not
   * hold yet is added: the address names a new conversation before any
   * re-read could land, and the App treats an address naming an agent it
   * cannot find as a conversation that is gone (see withAgentRow). */
  applyAgent: (agent: StellaAgent) => void;
  /** Switch an agent off or back on, and take the row the server answered.
   * Both the row's menu and the conversation's read-only notice call this,
   * so the two cannot disagree about whether the agent is on. Rejects when
   * the server refused; the caller shows why. */
  setAgentEnabled: (id: string, enabled: boolean) => Promise<void>;
};

export function useStella(
  enabled: boolean,
  activeAgentId: string | null,
): StellaHook {
  /** The one failure line this hook answers with. Both reads report on it —
   * a list that could not be read, and a conversation that could not be
   * opened, set it, and a read that succeeds clears it — so it is held here,
   * where the two hooks meet, rather than in either of them. */
  const [error, setError] = useState<string | null>(null);
  const {
    agents,
    agentsLoading,
    reloadAgents,
    applyAgent,
    applyAgentPreview,
    setAgentEnabled,
  } = useStellaAgents(enabled, setError);

  // Whether the agent the address names is switched off, as the list knows
  // it. Read as a boolean because it is a dependency of the open effect: the
  // conversation must be re-read when the switch flips, and a row that merely
  // refreshed its preview must not reopen anything.
  const activeAgent = agents.find((agent) => agent.id === activeAgentId);
  const activeAgentDisabled =
    activeAgent !== undefined && activeAgent.disabledAt !== null;

  const {
    conversation,
    conversationAgentId,
    settled,
    sessionId,
    prompt,
    uploadFile,
    abort,
    answer,
    rewind,
    finishHandover,
    provideEnv,
    declineEnv,
    lendShare,
    declineShare,
    loadOlder,
    loadingOlder,
    loading,
  } = useStellaConversation(
    enabled,
    activeAgentId,
    activeAgentDisabled,
    setError,
  );

  // The row of the conversation that is open, advanced from its own entries:
  // the list re-reads every 30 seconds, but the message the user just
  // received is on screen now, and a row that lags behind the conversation
  // beside it is the kind of disagreement this line exists to avoid. The
  // preview is built by the same function the server used, so the two can
  // only say the same thing.
  //
  // Written into the row, not derived from the selection. A list computed as
  // "the rows, with the selected conversation's newest message folded in"
  // changes when the selection does: the message the previously selected row
  // had been showing is taken back out, and two recent conversations swap
  // places every time the reader looks at the other one. A row may move when
  // something is SAID — that is the list's order — and not when a row is
  // opened.
  useEffect(() => {
    if (!enabled || conversation === null || conversationAgentId === null) {
      return;
    }
    // The frames before the selection's read lands show this page's cached
    // copy. It is the agent's, but the list may have heard of a newer message
    // while the reader was away; the read that follows is what may move the
    // row (the next run of this effect).
    if (!settled) return;
    // The frame in which the address has moved on but the effect that drops
    // the state has not run yet still holds the previous conversation. Its
    // messages are not this agent's last words.
    if (conversationAgentId !== activeAgentId) return;
    const preview = newestPreview(conversation.entries);
    if (preview === null) return;
    applyAgentPreview(conversationAgentId, preview);
  }, [
    enabled,
    activeAgentId,
    conversationAgentId,
    conversation,
    settled,
    applyAgentPreview,
  ]);

  return {
    agents,
    agentsLoading,
    activeAgentId,
    conversation,
    loadOlder,
    loadingOlder,
    sessionId,
    prompt,
    uploadFile,
    abort,
    answer,
    rewind,
    finishHandover,
    provideEnv,
    declineEnv,
    lendShare,
    declineShare,
    error,
    loading,
    reloadAgents,
    applyAgent,
    setAgentEnabled,
  };
}
