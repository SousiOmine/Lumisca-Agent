import {
  mergeAgentRows,
  withAgentPreview,
  withAgentRow,
} from "@lumisca/core/shared";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { describeError, useT } from "../i18n.ts";
import type {
  StellaAgent,
  StellaAgentSummary,
  StellaPreview,
} from "../types.ts";
import { NEVER, useVisibleInterval } from "./useVisibleInterval.ts";

/** How often the agent list is re-read while the page is visible.
 *
 * The list says what each conversation last said, and only the conversation
 * being looked at has an open stream: a routine that posts overnight, or a
 * second window showing the same server, writes into conversations whose rows
 * this client never hears about. Re-reading the list is the only way those
 * rows change. Nothing runs while the page is hidden (see useVisibleInterval)
 * — nobody is reading it. */
const AGENT_LIST_REFRESH_MS = 30_000;

/**
 * The sidebar's rows and the four things a caller does to them: re-read the
 * list, take one row the server just answered, fold the open conversation's
 * newest entry into its row, and switch an agent on or off.
 *
 * Which conversation is open is not this hook's business — the address names
 * it (see useStella) — so a list that arrives decides only what the sidebar
 * draws. `setError` is the failure line the hook's caller answers with: a
 * list read that fails is said there, and a read that succeeds clears it.
 */
export type StellaAgentList = {
  /** The rows, newest message first (see compareAgentRows). */
  agents: StellaAgentSummary[];
  /** The first read is in flight, so the list is empty because it is on its
   * way rather than because there is nothing. */
  agentsLoading: boolean;
  reloadAgents: () => void;
  applyAgent: (agent: StellaAgent) => void;
  setAgentEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Put the open conversation's newest entry into that agent's row, so the
   * row moves when something is said instead of up to a refresh later. */
  applyAgentPreview: (agentId: string, preview: StellaPreview) => void;
};

export function useStellaAgents(
  enabled: boolean,
  setError: (failure: string | null) => void,
): StellaAgentList {
  const t = useT();
  const [agents, setAgents] = useState<StellaAgentSummary[]>([]);
  /** Whether the first read of the list has settled (a failure counts: the
   * list is then known to be empty). `agentsLoading` is derived from it, so
   * the very first paint already says "reading" instead of flashing the
   * empty state for a frame. */
  const [agentsSettled, setAgentsSettled] = useState(false);
  const [agentsVersion, setAgentsVersion] = useState(0);

  const reloadAgents = useCallback(() => {
    setAgentsVersion((version) => version + 1);
  }, []);

  /** Take the row the server answered. An edit keeps the row's own preview
   * and place; a create adds a row that has said nothing yet. In both cases
   * the list is the answer's, not a re-read's — see withAgentRow. */
  const applyAgent = useCallback((agent: StellaAgent) => {
    setAgents((current) => withAgentRow(current, agent));
  }, []);

  const applyAgentPreview = useCallback(
    (agentId: string, preview: StellaPreview) => {
      setAgents((current) => withAgentPreview(current, agentId, preview));
    },
    [],
  );

  const setAgentEnabled = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      // The answer carries the row: the list moves it under the fold, and
      // the open conversation's effect re-runs because its agent's state
      // changed (see the open effect's dependencies).
      applyAgent(await api.updateStellaAgent(id, { enabled }));
    },
    [applyAgent],
  );

  // The agent list: read when stella becomes the mode, after a change, and on
  // the refresh timer below. Nothing here picks a conversation — the address
  // does (see the module comment), so a list that arrives decides only what
  // the sidebar draws.
  useEffect(() => {
    if (!enabled) {
      setAgents([]);
      setAgentsSettled(false);
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const { agents: list } = await api.getStellaAgents();
        if (disposed) return;
        // Folded into what the list holds rather than replacing it: a read
        // that was in flight when a message landed would otherwise put that
        // row back (see mergeAgentRows).
        setAgents((current) => mergeAgentRows(current, list));
        setError(null);
      } catch (failure) {
        if (!disposed) setError(describeError(failure, t));
      } finally {
        // Settled either way: a failed read leaves an empty list, and the
        // empty state is then the truth.
        if (!disposed) setAgentsSettled(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [enabled, agentsVersion, t, setError]);

  // The list's second line goes stale on its own: another window, or a
  // routine, writes into conversations this client has no stream for. A
  // re-read is the only thing that moves those rows, and it is cheap (a
  // bounded read per agent, see stella/previews.ts).
  useVisibleInterval(reloadAgents, enabled ? AGENT_LIST_REFRESH_MS : NEVER, {
    immediate: false,
  });

  return {
    agents,
    // Only the very first read counts: a 30-second refresh replaces rows that
    // are already on screen, and swapping them for "Loading…" would take real
    // content away to say nothing new.
    agentsLoading: enabled && !agentsSettled,
    reloadAgents,
    applyAgent,
    applyAgentPreview,
    setAgentEnabled,
  };
}
